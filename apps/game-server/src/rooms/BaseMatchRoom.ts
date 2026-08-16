import * as crypto from "node:crypto";
import type { Socket } from "socket.io";
import {
  RECONNECT_WINDOW_S,
  ServerMessage,
  type EndReason,
  type GameType,
  type JoinedPayload,
  type MatchResultPayload,
  type Seat,
} from "@ah/shared";
import {
  countDisconnect,
  createMatch,
  heartbeat,
  markInProgress,
  recordEvent,
  type MatchRecord,
} from "../services/match.service";
import { escrowMatch, getBalance, settleMatch, voidMatch, WalletError } from "../services/wallet.service";

const HEARTBEAT_MS = 10_000;

export interface RoomPlayer {
  userId: string;
  displayName: string;
  seat: Seat;
  socket: Socket | null;
  connected: boolean;
  reconnectMs: number;
  /** Credencial para volver a esta partida tras una caida. */
  resumeToken: string;
}

/**
 * Ciclo de vida y dinero de una partida 1v1, sea cual sea el juego.
 *
 * ---------------------------------------------------------------------------
 * Por que existe esta clase
 * ---------------------------------------------------------------------------
 * Escrow, liquidacion, anulacion, ventana de reconexion, abandono y latido a
 * la base son identicos en Air Hockey y en Mines. Tener dos copias de eso
 * seria tener dos sitios donde el dinero puede salir mal, y solo haria falta
 * arreglar un bug en uno de los dos para que la plataforma pague de mas.
 *
 * Aqui vive todo eso UNA vez. Cada juego concreto solo implementa su propia
 * partida: como se juega, cuando termina y quien gana.
 *
 * La clase no sabe nada de fisica ni de tableros, y no depende de ningun
 * framework: recibe sockets ya autenticados. Eso la hace testeable sin red.
 * ---------------------------------------------------------------------------
 */
export abstract class BaseMatchRoom {
  readonly id: string;
  protected players: RoomPlayer[] = [];
  protected match: MatchRecord | null = null;
  protected settled = false;
  protected disposed = false;

  private heartbeatLoop: NodeJS.Timeout | null = null;
  private reconnectTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    readonly gameType: GameType,
    readonly stake: number,
    private readonly onDisposed: (room: BaseMatchRoom) => void,
  ) {
    this.id = crypto.randomUUID();
  }

  // -------------------------------------------------------------------------
  // Contrato que implementa cada juego
  // -------------------------------------------------------------------------

  /** Parametros que se guardan en `matches.config` para auditoria. */
  protected abstract gameConfig(): Record<string, unknown>;

  /**
   * Compromiso criptografico del estado inicial, si el juego lo tiene.
   * Se publica antes de la primera jugada y se revela al terminar.
   */
  protected abstract commitHash(): string | null;

  /** Arranca la partida. El dinero ya esta bloqueado cuando se llama. */
  protected abstract onMatchStart(): void;

  /** Detiene temporizadores y bucles propios del juego. */
  protected abstract onMatchStop(): void;

  /** Registra los handlers de eventos propios del juego en un socket. */
  protected abstract bindGameEvents(player: RoomPlayer, socket: Socket): void;

  /** Nombres de los eventos propios, para poder desregistrarlos al reenganchar. */
  protected abstract gameEventNames(): string[];

  /** Marcador actual por asiento. Se persiste en la liquidacion. */
  protected abstract currentScores(): [number, number];

  /** Envia el estado completo a un jugador (al entrar o al reconectar). */
  protected abstract sendSnapshot(player: RoomPlayer): void;

  /** Se llama cuando un jugador se cae o vuelve. */
  protected onConnectionChange(_player: RoomPlayer): void {
    /* opcional */
  }

  // -------------------------------------------------------------------------
  // Alta de jugadores
  // -------------------------------------------------------------------------

  get isFull(): boolean {
    return this.players.length >= 2;
  }

  get matchId(): string | null {
    return this.match?.id ?? null;
  }

  add(socket: Socket, userId: string, displayName: string): RoomPlayer {
    const seat: Seat = this.players.length === 0 ? 0 : 1;
    const player: RoomPlayer = {
      userId,
      displayName,
      seat,
      socket,
      connected: true,
      reconnectMs: 0,
      resumeToken: crypto.randomBytes(24).toString("base64url"),
    };
    this.players.push(player);
    this.bind(player, socket);
    return player;
  }

  findByResumeToken(token: string): RoomPlayer | undefined {
    return this.players.find((p) => p.resumeToken === token);
  }

  /** Reengancha un socket nuevo a un jugador que se habia caido. */
  resume(player: RoomPlayer, socket: Socket): void {
    const timer = this.reconnectTimers.get(player.userId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(player.userId);
    }

    player.socket = socket;
    player.connected = true;
    player.reconnectMs = 0;
    this.bind(player, socket);
    this.sendJoined(player);
    this.sendSnapshot(player);
    this.onConnectionChange(player);

    this.opponentOf(player)?.socket?.emit(ServerMessage.OPPONENT, {
      connected: true,
      reconnectMs: 0,
    });
    void this.record("reconnect", { seat: player.seat }, player);
  }

  private bind(player: RoomPlayer, socket: Socket): void {
    for (const event of ["ping", "forfeit", "disconnect", ...this.gameEventNames()]) {
      socket.removeAllListeners(event);
    }

    socket.on("ping", (payload: unknown) => {
      const t =
        typeof payload === "object" &&
        payload !== null &&
        typeof (payload as { t?: unknown }).t === "number" &&
        Number.isFinite((payload as { t: number }).t)
          ? (payload as { t: number }).t
          : 0;
      socket.emit(ServerMessage.PONG, { t, serverTick: 0 });
    });

    socket.on("forfeit", () => {
      if (this.settled) return;
      const opponent = this.opponentOf(player);
      if (opponent) void this.endMatch(opponent, "forfeit");
    });

    socket.on("disconnect", () => this.handleDisconnect(player, socket));

    this.bindGameEvents(player, socket);
  }

  // -------------------------------------------------------------------------
  // Arranque: registro de la partida y escrow
  // -------------------------------------------------------------------------

  /**
   * Crea la partida, bloquea el dinero de ambos y arranca el juego.
   *
   * El escrow es atomico: si a cualquiera le falta saldo, la transaccion se
   * revierte entera y nadie queda con dinero retenido.
   */
  async start(): Promise<void> {
    this.match = await createMatch(this.id, this.stake, {
      gameType: this.gameType,
      config: this.gameConfig(),
      commitHash: this.commitHash(),
    });

    try {
      await escrowMatch({
        matchId: this.match.id,
        stake: this.stake,
        players: this.players.map((p) => ({ userId: p.userId, seat: p.seat })),
      });
      await markInProgress(this.match.id);
      await this.record("escrow_ok", { stake: this.stake, gameType: this.gameType });
    } catch (error) {
      const code = error instanceof WalletError ? error.code : "error";
      const offender =
        error instanceof WalletError ? (error.details.userId as string | undefined) : undefined;

      console.error(`[room ${this.id}] escrow fallido:`, code, error);
      for (const player of this.players) {
        player.socket?.emit(ServerMessage.ESCROW_FAILED, {
          reason: code,
          isYou: offender === player.userId,
        });
      }
      await this.record("escrow_failed", { code, offender: offender ?? null });
      // El escrow es atomico: si fallo, nadie quedo con dinero retenido.
      await voidMatch({ matchId: this.match.id, reason: "cancelled" });
      this.settled = true;
      this.dispose(1500);
      return;
    }

    for (const player of this.players) this.sendJoined(player);

    this.heartbeatLoop = setInterval(() => {
      if (this.match && !this.settled) {
        void heartbeat(this.match.id).catch((e) => console.error("[room] heartbeat", e));
      }
    }, HEARTBEAT_MS);

    this.onMatchStart();
  }

  private sendJoined(player: RoomPlayer): void {
    const payload: JoinedPayload = {
      matchId: this.match?.id ?? "",
      gameType: this.gameType,
      seat: player.seat,
      stake: this.stake,
      opponentName: this.opponentOf(player)?.displayName ?? "",
      resumeToken: player.resumeToken,
    };
    player.socket?.emit(ServerMessage.JOINED, payload);
  }

  // -------------------------------------------------------------------------
  // Desconexion y reconexion
  // -------------------------------------------------------------------------

  private handleDisconnect(player: RoomPlayer, socket: Socket): void {
    // Un socket viejo desconectandose despues de una reconexion no cuenta.
    if (player.socket !== socket) return;
    if (this.settled || this.disposed) return;

    player.socket = null;
    player.connected = false;
    player.reconnectMs = RECONNECT_WINDOW_S * 1000;

    if (this.match) void countDisconnect(this.match.id, player.userId);
    void this.record("disconnect", { seat: player.seat }, player);
    this.onConnectionChange(player);

    this.opponentOf(player)?.socket?.emit(ServerMessage.OPPONENT, {
      connected: false,
      reconnectMs: RECONNECT_WINDOW_S * 1000,
    });

    // Antes del escrow no hay dinero en juego: la sala simplemente muere.
    if (!this.match || this.playersHaveNoStake()) {
      void this.cancelBeforeStart();
      return;
    }

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(player.userId);
      if (this.settled || player.connected) return;

      void this.record("abandon", { seat: player.seat }, player);
      const rival = this.opponentOf(player);
      if (rival?.connected) {
        void this.endMatch(rival, "abandon");
      } else {
        // Se cayeron los dos: nadie gana, se devuelve el dinero.
        void this.abortMatch("error");
      }
    }, RECONNECT_WINDOW_S * 1000);

    this.reconnectTimers.set(player.userId, timer);
  }

  /** Cierta solo antes de que el escrow haya bloqueado nada. */
  private playersHaveNoStake(): boolean {
    return this.heartbeatLoop === null;
  }

  /** Milisegundos que le quedan al jugador caido, si hay alguno. */
  protected disconnectedPlayer(): RoomPlayer | undefined {
    return this.players.find((p) => !p.connected);
  }

  // -------------------------------------------------------------------------
  // Cierre y liquidacion
  // -------------------------------------------------------------------------

  /**
   * Declara ganador, liquida y avisa a cada jugador su saldo final.
   *
   * `this.settled` se marca ANTES del await: si dos caminos (por ejemplo un
   * fin de partida y la expiracion de una reconexion) intentan terminar la
   * misma partida a la vez, solo uno pasa. Y aunque pasaran los dos,
   * `settleMatch` es idempotente en la base.
   */
  protected async endMatch(winner: RoomPlayer, reason: EndReason): Promise<void> {
    if (this.settled || !this.match) return;
    this.settled = true;
    this.stopLoops();

    const scores = this.currentScores();

    try {
      const result = await settleMatch({
        matchId: this.match.id,
        winnerUserId: winner.userId,
        endReason: reason,
        scoreHome: scores[0],
        scoreAway: scores[1],
      });

      for (const player of this.players) {
        const payload: MatchResultPayload = {
          matchId: this.match.id,
          winnerUserId: winner.userId,
          youWon: player.userId === winner.userId,
          endReason: reason,
          scores,
          payout: result.payout,
          rake: result.rake,
          balanceAfter: result.balances[player.userId]?.available ?? 0,
        };
        player.socket?.emit(ServerMessage.MATCH_RESULT, payload);
      }

      await this.record("settled", {
        winner: winner.userId,
        reason,
        payout: result.payout,
        rake: result.rake,
      });
    } catch (error) {
      // La partida se jugo pero la liquidacion fallo. NO se toca el dinero a
      // ciegas: queda sin liquidar y la resuelve el sweeper. Perder una
      // liquidacion es un incidente; pagar dos veces es un agujero.
      console.error(`[room ${this.id}] FALLO LA LIQUIDACION`, error);
      await this.record("settlement_failed", { error: String(error) });

      // Sin este aviso, cada jugador se queda mirando la pantalla de
      // revelado hasta que `dispose` tumbe su socket 5s despues sin
      // explicacion, y de ahi en mas ve "la partida ya termino" al
      // reconectar — nunca un resultado. `payout: null` es el mismo camino
      // que ya usa el cliente para una anulacion (ver BlackjackPanel): no se
      // afirma ganador ni se muestra saldo con la apuesta perdida, porque
      // el sweeper todavia va a reembolsar esta partida completa.
      for (const player of this.players) {
        const balanceAfter = await getBalance(player.userId)
          .then((b) => b.available)
          .catch(() => 0);
        player.socket?.emit(ServerMessage.MATCH_RESULT, {
          matchId: this.match.id,
          winnerUserId: null,
          youWon: false,
          endReason: reason,
          scores,
          payout: null,
          rake: null,
          balanceAfter,
        } satisfies MatchResultPayload);
      }
    }

    this.dispose(5000);
  }

  /** Anula una partida ya escrowed y devuelve el dinero a los dos. */
  protected async abortMatch(reason: EndReason): Promise<void> {
    if (this.settled || !this.match) return;
    this.settled = true;
    this.stopLoops();

    const scores = this.currentScores();

    try {
      const result = await voidMatch({ matchId: this.match.id, reason });
      for (const player of this.players) {
        player.socket?.emit(ServerMessage.MATCH_RESULT, {
          matchId: this.match.id,
          winnerUserId: null,
          youWon: false,
          endReason: reason,
          scores,
          payout: null,
          rake: null,
          balanceAfter: result.balances[player.userId]?.available ?? 0,
        } satisfies MatchResultPayload);
      }
    } catch (error) {
      console.error(`[room ${this.id}] fallo la anulacion`, error);
    }

    this.dispose(3000);
  }

  /** Cierra la sala sin que llegara a haber partida con dinero. */
  private async cancelBeforeStart(): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    this.stopLoops();
    if (this.match) {
      try {
        await voidMatch({ matchId: this.match.id, reason: "cancelled" });
      } catch (error) {
        console.error(`[room ${this.id}] fallo cancelBeforeStart`, error);
      }
    }
    this.dispose(500);
  }

  /**
   * Cierre forzado desde fuera (apagado del servidor).
   *
   * Devuelve el dinero: que un jugador pierda por un fallo NUESTRO seria
   * inaceptable, asi que ante caida de infraestructura siempre se devuelve.
   */
  async forceVoid(reason: EndReason = "error"): Promise<void> {
    await this.abortMatch(reason);
  }

  private stopLoops(): void {
    this.onMatchStop();
    if (this.heartbeatLoop) clearInterval(this.heartbeatLoop);
    this.heartbeatLoop = null;
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
  }

  protected dispose(afterMs: number): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopLoops();
    setTimeout(() => {
      for (const player of this.players) player.socket?.disconnect(true);
      this.onDisposed(this);
    }, afterMs).unref();
  }

  // -------------------------------------------------------------------------
  // Utilidades para los juegos
  // -------------------------------------------------------------------------

  protected emitAll(event: string, payload: unknown): void {
    for (const player of this.players) player.socket?.emit(event, payload);
  }

  protected playerAt(seat: Seat): RoomPlayer | undefined {
    return this.players.find((p) => p.seat === seat);
  }

  protected opponentOf(player: RoomPlayer): RoomPlayer | undefined {
    return this.players.find((p) => p.userId !== player.userId);
  }

  protected async record(
    type: string,
    payload: Record<string, unknown>,
    player?: RoomPlayer,
  ): Promise<void> {
    if (!this.match) return;
    await recordEvent(this.match.id, type, payload, { userId: player?.userId });
  }
}
