import * as crypto from "node:crypto";
import type { Socket } from "socket.io";
import {
  MINES_LIVES,
  MINES_MAX_TIMEOUTS,
  MINES_REVEAL_DELAY_MS,
  MINES_TURN_SECONDS,
  MinesClientMessage,
  MinesServerMessage,
  TILE_HIDDEN,
  TILE_MINE,
  TILE_SAFE,
  deriveMinePositions,
  minesFor,
  type MinesFairnessPayload,
  type MinesPhase,
  type MinesSize,
  type MinesState,
  type Seat,
} from "@ah/shared";
import { revealSeed, updateScore } from "../services/match.service";
import { BaseMatchRoom, type RoomPlayer } from "./BaseMatchRoom";

/** Como maximo cuantas jugadas por segundo acepta el servidor de un cliente. */
const ACTION_RATE_LIMIT_HZ = 6;

/**
 * Cada cuanto se comprueba si expiro el turno.
 *
 * Se sondea en vez de programar un `setTimeout` de 10 s exactos porque el
 * reloj tiene que poder CONGELARSE cuando un jugador se cae: un temporizador
 * ya programado seguiria corriendo y le quitaria una vida a alguien que ni
 * siquiera esta conectado.
 */
const TURN_TICK_MS = 250;

interface MinesPlayerState {
  lives: number;
  /** Ausencias consecutivas. Se reinicia al jugar. */
  timeouts: number;
  lastAction: number;
  actionTokens: number;
}

/**
 * Sala de Minas 1v1.
 *
 * ---------------------------------------------------------------------------
 * Donde vive el tablero
 * ---------------------------------------------------------------------------
 * `mineSet` vive SOLO en la memoria de este objeto. Al cliente nunca se le
 * envia la matriz completa: `revealedTiles` empieza con todo en TILE_HIDDEN y
 * solo se rellena la casilla concreta que alguien acaba de destapar.
 *
 * No existe forma de leer la posicion de una mina desde el navegador: ni
 * parcheando el JavaScript, ni inspeccionando el trafico, ni volcando la
 * memoria de la pestaña. La informacion sencillamente no esta ahi.
 *
 * ---------------------------------------------------------------------------
 * Juego limpio demostrable
 * ---------------------------------------------------------------------------
 * La semilla se genera con `crypto.randomBytes(32)` — un CSPRNG, no
 * `Math.random()`. Pero un CSPRNG solo prueba que el tablero es impredecible;
 * no le prueba nada AL JUGADOR, que no puede ver nuestro servidor.
 *
 * Por eso se publica `commit = sha256(seed)` antes de la primera jugada y se
 * revela `seed` al terminar. En un juego que es puro azar esto no es un
 * adorno: es lo unico que separa "el tablero es aleatorio" de una promesa.
 * ---------------------------------------------------------------------------
 */
export class MinesRoom extends BaseMatchRoom {
  private readonly size: MinesSize;
  private readonly mineCount: number;

  /** Semilla secreta hasta el final de la partida. */
  private readonly seed: string;
  private readonly commit: string;

  /** Posiciones de las minas. NUNCA salen de aqui hasta el final. */
  private readonly mines: number[];
  private readonly mineSet: Set<number>;

  /** Lo unico que el cliente llega a ver. */
  private revealedTiles: number[];
  private owners: number[];

  private phase: MinesPhase = "waiting";
  private currentTurnSeat: Seat = 0;
  private turnEndsAt = 0;
  private safeRemaining: number;
  private turnLoop: NodeJS.Timeout | null = null;
  /** Bloqueo durante la animacion de destape. */
  private locked = false;

  private own = new Map<string, MinesPlayerState>();

  constructor(stake: number, size: MinesSize, onDisposed: (room: BaseMatchRoom) => void) {
    super("mines", stake, onDisposed);

    this.size = size;
    this.mineCount = minesFor(size);

    // CSPRNG: 32 bytes. `Math.random()` seria predecible y en un juego de azar
    // con dinero eso es el agujero entero.
    this.seed = crypto.randomBytes(32).toString("hex");
    this.commit = crypto.createHash("sha256").update(this.seed).digest("hex");

    this.mines = deriveMinePositions(this.seed, size, this.mineCount);
    this.mineSet = new Set(this.mines);

    const total = size * size;
    this.revealedTiles = new Array<number>(total).fill(TILE_HIDDEN);
    this.owners = new Array<number>(total).fill(-1);
    this.safeRemaining = total - this.mineCount;
  }

  // -------------------------------------------------------------------------
  // Contrato con la clase base
  // -------------------------------------------------------------------------

  protected gameConfig(): Record<string, unknown> {
    return {
      size: this.size,
      mines: this.mineCount,
      lives: MINES_LIVES,
      turnSeconds: MINES_TURN_SECONDS,
      maxTimeouts: MINES_MAX_TIMEOUTS,
    };
  }

  protected commitHash(): string {
    return this.commit;
  }

  protected gameEventNames(): string[] {
    return [MinesClientMessage.REVEAL];
  }

  protected bindGameEvents(player: RoomPlayer, socket: Socket): void {
    if (!this.own.has(player.userId)) {
      this.own.set(player.userId, {
        lives: MINES_LIVES,
        timeouts: 0,
        lastAction: Date.now(),
        actionTokens: ACTION_RATE_LIMIT_HZ,
      });
    }
    socket.on(MinesClientMessage.REVEAL, (payload: unknown) => this.revealTile(player, payload));
  }

  protected onMatchStart(): void {
    this.phase = "playing";
    // Quien empieza sale de la semilla, no de quien entro primero: si
    // empezara siempre el asiento 0, entrar antes seria una ventaja.
    this.currentTurnSeat = (parseInt(this.seed.slice(0, 2), 16) % 2) as Seat;
    this.resetTurnClock();

    this.turnLoop = setInterval(() => this.checkTurnExpiry(), TURN_TICK_MS);
    this.broadcastState();
  }

  protected onMatchStop(): void {
    if (this.turnLoop) clearInterval(this.turnLoop);
    this.turnLoop = null;
  }

  /**
   * Lo que se persiste como marcador son las VIDAS restantes: en estas reglas
   * no hay puntos, y las vidas son lo que decide la partida.
   */
  protected currentScores(): [number, number] {
    return [this.livesOf(0), this.livesOf(1)];
  }

  protected sendSnapshot(player: RoomPlayer): void {
    player.socket?.emit(MinesServerMessage.STATE, this.buildState());
  }

  protected onConnectionChange(): void {
    // El reloj del turno se congela mientras alguien esta caido.
    this.broadcastState();
  }

  // -------------------------------------------------------------------------
  // Jugada: destapar una casilla
  // -------------------------------------------------------------------------

  /**
   * Unica accion del juego.
   *
   * Cinco barreras antes de tocar el tablero, y ninguna confia en la anterior:
   * fase valida, cuota de mensajes, es tu turno, no hay animacion en curso, y
   * el indice es un entero dentro del tablero que sigue oculto.
   */
  private revealTile(player: RoomPlayer, payload: unknown): void {
    const own = this.own.get(player.userId);
    if (!own) return;

    if (this.phase !== "playing") return this.reject(player, "not_playing");
    if (!this.consumeAction(own)) return this.reject(player, "rate_limited");
    if (player.seat !== this.currentTurnSeat) return this.reject(player, "not_your_turn");
    if (this.locked) return this.reject(player, "rate_limited");

    const index = this.parseIndex(payload);
    if (index === null) return this.reject(player, "out_of_range");
    if (this.revealedTiles[index] !== TILE_HIDDEN) return this.reject(player, "already_revealed");

    // Jugar reinicia el contador de ausencias.
    own.timeouts = 0;

    const isMine = this.mineSet.has(index);
    this.revealedTiles[index] = isMine ? TILE_MINE : TILE_SAFE;
    this.owners[index] = player.seat;

    if (isMine) {
      own.lives -= 1;
      this.emitAll(MinesServerMessage.EXPLODED, {
        index,
        seat: player.seat,
        livesLeft: own.lives,
      });
      void this.record("mine", { seat: player.seat, index, livesLeft: own.lives }, player);
    } else {
      this.safeRemaining -= 1;
      this.emitAll(MinesServerMessage.SAFE, {
        index,
        seat: player.seat,
        livesLeft: own.lives,
      });
      void this.record("safe", { seat: player.seat, index }, player);
    }

    if (this.matchId) {
      const [home, away] = this.currentScores();
      void updateScore(this.matchId, home, away);
    }

    // Sin vidas: la partida termina en el acto.
    if (own.lives <= 0) {
      this.finishByLives(player);
      return;
    }

    // Tablero despejado: gana quien conserve mas vidas.
    if (this.safeRemaining <= 0) {
      this.finishByBoardCleared();
      return;
    }

    // Una casilla por turno: el turno pasa siempre, haya mina o no. La pausa
    // es solo para que la animacion se vea antes del cambio.
    this.locked = true;
    this.broadcastState();
    setTimeout(() => {
      this.locked = false;
      if (this.phase !== "playing") return;
      this.passTurn();
    }, MINES_REVEAL_DELAY_MS).unref();
  }

  // -------------------------------------------------------------------------
  // Turnos y temporizador
  // -------------------------------------------------------------------------

  private resetTurnClock(): void {
    this.turnEndsAt = Date.now() + MINES_TURN_SECONDS * 1000;
  }

  private passTurn(): void {
    this.currentTurnSeat = this.currentTurnSeat === 0 ? 1 : 0;
    this.resetTurnClock();
    this.broadcastState();
  }

  /**
   * Vigila el reloj del turno.
   *
   * Con un jugador caido el reloj se congela: la ventana de reconexion ya se
   * encarga de ese caso, y dejar correr el turno le quitaria vidas a alguien
   * que no puede jugar — castigarlo dos veces por la misma desconexion.
   */
  private checkTurnExpiry(): void {
    if (this.phase !== "playing" || this.locked) return;

    if (this.disconnectedPlayer()) {
      this.resetTurnClock();
      return;
    }

    if (Date.now() < this.turnEndsAt) return;

    const player = this.playerAt(this.currentTurnSeat);
    const own = player ? this.own.get(player.userId) : undefined;
    if (!player || !own) return;

    // Penalizacion por ausencia: cuesta una vida, igual que pisar una mina.
    own.lives -= 1;
    own.timeouts += 1;

    this.emitAll(MinesServerMessage.TIMEOUT, {
      seat: player.seat,
      livesLeft: own.lives,
      strikes: own.timeouts,
    });
    void this.record(
      "timeout",
      { seat: player.seat, livesLeft: own.lives, strikes: own.timeouts },
      player,
    );

    if (this.matchId) {
      const [home, away] = this.currentScores();
      void updateScore(this.matchId, home, away);
    }

    if (own.lives <= 0) {
      this.finishByLives(player);
      return;
    }

    // Dos ausencias seguidas: se considera abandono. Sin esto, un jugador
    // podria dejar la partida colgada con el dinero bloqueado hasta gastar
    // sus tres vidas muy despacio.
    if (own.timeouts >= MINES_MAX_TIMEOUTS) {
      const rival = this.opponentOf(player);
      this.phase = "finished";
      this.publishFairness();
      void this.record("abandon_afk", { seat: player.seat }, player);
      if (rival) void this.endMatch(rival, "abandon");
      else void this.abortMatch("error");
      return;
    }

    this.passTurn();
  }

  // -------------------------------------------------------------------------
  // Finales
  // -------------------------------------------------------------------------

  /** Un jugador llego a 0 vidas: el pozo es del rival. */
  private finishByLives(loser: RoomPlayer): void {
    this.phase = "finished";
    this.publishFairness();
    void this.record("out_of_lives", { seat: loser.seat });

    const winner = this.opponentOf(loser);
    if (winner) void this.endMatch(winner, "score");
    else void this.abortMatch("error");
  }

  /** Tablero despejado: gana quien tenga mas vidas; empate se anula. */
  private finishByBoardCleared(): void {
    this.phase = "finished";
    const [home, away] = this.currentScores();
    this.publishFairness();
    void this.record("board_cleared", { home, away });

    if (home === away) {
      // Empate a vidas: nadie gana, se devuelve la apuesta integra.
      void this.abortMatch("timeout");
      return;
    }

    const winner = this.playerAt(home > away ? 0 : 1);
    if (winner) void this.endMatch(winner, "score");
    else void this.abortMatch("error");
  }

  /**
   * Revela la semilla. Se llama SOLO cuando la partida ya termino: hacerlo
   * antes le entregaria el tablero al jugador.
   */
  private publishFairness(): void {
    const payload: MinesFairnessPayload = {
      commit: this.commit,
      seed: this.seed,
      size: this.size,
      mines: this.mineCount,
      positions: this.mines,
    };
    this.emitAll(MinesServerMessage.FAIRNESS, payload);
    if (this.matchId) void revealSeed(this.matchId);
  }

  // -------------------------------------------------------------------------
  // Estado publico
  // -------------------------------------------------------------------------

  /**
   * Construye lo que el cliente puede saber.
   *
   * Se copian los arreglos a proposito: devolver la referencia interna haria
   * que un cambio posterior se colara en un payload ya emitido.
   */
  private buildState(): MinesState {
    return {
      phase: this.phase,
      size: this.size,
      mines: this.mineCount,
      revealedTiles: [...this.revealedTiles],
      owners: [...this.owners],
      lives: this.currentScores(),
      timeouts: [this.timeoutsOf(0), this.timeoutsOf(1)],
      currentTurnSeat: this.currentTurnSeat,
      turnMs: Math.max(0, this.turnEndsAt - Date.now()),
      safeRemaining: this.safeRemaining,
      commit: this.commit,
    };
  }

  private broadcastState(): void {
    this.emitAll(MinesServerMessage.STATE, this.buildState());
  }

  // -------------------------------------------------------------------------
  // Validacion y utilidades
  // -------------------------------------------------------------------------

  /** Acepta solo un entero dentro del tablero. Nada de NaN, floats ni strings. */
  private parseIndex(payload: unknown): number | null {
    const raw =
      typeof payload === "number"
        ? payload
        : typeof payload === "object" && payload !== null
          ? (payload as { index?: unknown }).index
          : undefined;

    if (typeof raw !== "number" || !Number.isInteger(raw)) return null;
    if (raw < 0 || raw >= this.size * this.size) return null;
    return raw;
  }

  /** Cubeta de tokens: un cliente automatizado no puede inundar el turno. */
  private consumeAction(own: MinesPlayerState): boolean {
    const now = Date.now();
    const elapsed = (now - own.lastAction) / 1000;
    own.lastAction = now;
    own.actionTokens = Math.min(
      ACTION_RATE_LIMIT_HZ,
      own.actionTokens + elapsed * ACTION_RATE_LIMIT_HZ,
    );
    if (own.actionTokens < 1) return false;
    own.actionTokens -= 1;
    return true;
  }

  private reject(player: RoomPlayer, reason: string): void {
    player.socket?.emit(MinesServerMessage.REJECTED, { reason });
  }

  private livesOf(seat: Seat): number {
    const player = this.playerAt(seat);
    return player ? (this.own.get(player.userId)?.lives ?? MINES_LIVES) : MINES_LIVES;
  }

  private timeoutsOf(seat: Seat): number {
    const player = this.playerAt(seat);
    return player ? (this.own.get(player.userId)?.timeouts ?? 0) : 0;
  }
}
