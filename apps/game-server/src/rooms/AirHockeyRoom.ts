import type { Socket } from "socket.io";
import {
  COUNTDOWN_MS,
  GOAL_FREEZE_MS,
  GOALS_TO_WIN,
  INPUT_RATE_LIMIT_HZ,
  MATCH_TIMEOUT_MS,
  ServerMessage,
  TICKS_PER_SNAPSHOT,
  TICK_MS,
  decodeInput,
  encodeState,
  seqDelta,
  type GamePhase,
  type Seat,
} from "@ah/shared";
import { FixedClock, type ClockMetrics } from "../game/FixedClock";
import { TARGET_TOLERANCE } from "../game/constants";
import {
  createWorld,
  resetForFaceoff,
  sanitizeTarget,
  step,
  stepMalletsOnly,
  type World,
} from "../game/physics";
import { updateScore } from "../services/match.service";
import { BaseMatchRoom, type RoomPlayer } from "./BaseMatchRoom";

interface InputBudget {
  tokens: number;
  lastRefill: number;
  rejected: number;
  lastReport: number;
}

/** Estado propio del juego para cada jugador. */
interface AirHockeyPlayer {
  score: number;
  /**
   * Ultimo numero de secuencia de input que el servidor le aplico.
   *
   * Se devuelve en cada instantanea y es la base de la reconciliacion: el
   * cliente descarta de su cola los inputs ya confirmados y vuelve a aplicar
   * solo los pendientes sobre la posicion autoritativa.
   */
  ackSeq: number;
  budget: InputBudget;
}

/**
 * Sala de Air Hockey 1v1.
 *
 * ---------------------------------------------------------------------------
 * Modelo de confianza
 * ---------------------------------------------------------------------------
 * Del cliente se acepta exactamente una cosa: hacia donde quiere llevar SU
 * mazo. Nada mas. No manda posiciones del disco, ni velocidades, ni goles, ni
 * marcadores, ni timestamps, ni su propio userId — ese sale del JWT verificado
 * en el handshake del socket.
 *
 * Todo lo demas —fisica, colisiones, goles, marcador y fin de partida— se
 * calcula aqui. El dinero (escrow, liquidacion, abandono) lo maneja
 * `BaseMatchRoom`, que es comun a todos los juegos: una sola implementacion
 * del camino del dinero, no una por juego.
 * ---------------------------------------------------------------------------
 */
export class AirHockeyRoom extends BaseMatchRoom {
  private world: World = createWorld();
  private own = new Map<string, AirHockeyPlayer>();

  private phase: GamePhase = "waiting";
  private phaseTimer = 0;
  private tick = 0;
  private elapsedMs = 0;
  private lastConceded: Seat | null = null;
  private clock: FixedClock | null = null;

  constructor(stake: number, onDisposed: (room: BaseMatchRoom) => void) {
    super("air_hockey", stake, onDisposed);
  }

  // -------------------------------------------------------------------------
  // Contrato con la clase base
  // -------------------------------------------------------------------------

  protected gameConfig(): Record<string, unknown> {
    return { goalsToWin: GOALS_TO_WIN, tickRate: Math.round(1000 / TICK_MS) };
  }

  /** Air Hockey no tiene estado oculto: no hay nada que comprometer. */
  protected commitHash(): string | null {
    return null;
  }

  protected gameEventNames(): string[] {
    return ["input"];
  }

  protected bindGameEvents(player: RoomPlayer, socket: Socket): void {
    if (!this.own.has(player.userId)) {
      this.own.set(player.userId, {
        score: 0,
        ackSeq: 0,
        budget: { tokens: INPUT_RATE_LIMIT_HZ, lastRefill: Date.now(), rejected: 0, lastReport: 0 },
      });
    }
    socket.on("input", (payload: unknown) => this.handleInput(player, payload));
  }

  protected onMatchStart(): void {
    this.lastConceded = null;
    resetForFaceoff(this.world, null, 0);
    this.setPhase("countdown", COUNTDOWN_MS);

    // Un solo reloj gobierna la partida: la fisica y la emision de estado
    // salen del mismo tick, asi cada instantanea cae en un limite exacto de
    // simulacion y el cliente puede interpolar sobre la linea de tiempo del
    // servidor en vez de sobre la hora de llegada de los paquetes.
    this.clock = new FixedClock(TICK_MS, () => this.onTick());
    this.clock.start();
  }

  protected onMatchStop(): void {
    this.clock?.stop();
    this.clock = null;
  }

  protected currentScores(): [number, number] {
    return [this.scoreOf(0), this.scoreOf(1)];
  }

  protected sendSnapshot(player: RoomPlayer): void {
    // El bucle emite estado 60 veces por segundo: al reconectar basta con
    // esperar al siguiente tick, no hace falta un envio especial.
    void player;
  }

  /** Metricas del bucle de fisica, para diagnostico. */
  get clockMetrics(): ClockMetrics | null {
    return this.clock?.metrics ?? null;
  }

  // -------------------------------------------------------------------------
  // Entrada del jugador
  // -------------------------------------------------------------------------

  /**
   * Unico punto de entrada de la intencion del jugador.
   *
   * Tres barreras antes de tocar el mundo: fase valida, cuota de mensajes y
   * saneado geometrico. Ninguna confia en la anterior.
   */
  private handleInput(player: RoomPlayer, payload: unknown): void {
    const own = this.own.get(player.userId);
    if (!own) return;

    if (this.phase !== "playing" && this.phase !== "countdown") {
      player.socket?.emit(ServerMessage.INPUT_REJECTED, { reason: "not_playing" });
      return;
    }

    if (!this.consumeBudget(own)) {
      player.socket?.emit(ServerMessage.INPUT_REJECTED, { reason: "rate_limited" });
      return;
    }

    const input = decodeInput(payload);
    if (!input) {
      player.socket?.emit(ServerMessage.INPUT_REJECTED, { reason: "malformed" });
      this.flagSuspicious(player, own, "malformed");
      return;
    }

    const { target, rejection } = sanitizeTarget(input, player.seat, TARGET_TOLERANCE);
    if (!target) {
      player.socket?.emit(ServerMessage.INPUT_REJECTED, { reason: rejection ?? "malformed" });
      this.flagSuspicious(player, own, rejection ?? "malformed");
      return;
    }
    if (rejection === "out_of_bounds") {
      // El objetivo se recorta igual y el juego sigue; solo queda anotado.
      this.flagSuspicious(player, own, rejection);
    }

    // Solo avanza el acuse si la secuencia es mas nueva. Sin esto, un paquete
    // reordenado por la red haria retroceder el acuse y el cliente volveria a
    // aplicar inputs ya consumidos — un tiron hacia atras en el mazo propio.
    if (seqDelta(input.seq, own.ackSeq) > 0) {
      own.ackSeq = input.seq;
      this.world.mallets[player.seat].target = target;
    }
  }

  /**
   * Cubeta de tokens por jugador. Un cliente que inunda con inputs a 10 kHz no
   * gana precision — solo consume CPU — asi que se le corta en seco.
   */
  private consumeBudget(own: AirHockeyPlayer): boolean {
    const now = Date.now();
    const elapsed = (now - own.budget.lastRefill) / 1000;
    own.budget.lastRefill = now;
    own.budget.tokens = Math.min(
      INPUT_RATE_LIMIT_HZ,
      own.budget.tokens + elapsed * INPUT_RATE_LIMIT_HZ,
    );

    if (own.budget.tokens < 1) {
      own.budget.rejected++;
      return false;
    }
    own.budget.tokens -= 1;
    return true;
  }

  /**
   * Telemetria anti-trampa con freno.
   *
   * Escribir una fila por input rechazado convertiria a un cliente malicioso
   * en un ataque de escritura contra nuestra propia base. Se acumula y se
   * reporta como mucho una vez cada 5 segundos por jugador.
   */
  private flagSuspicious(player: RoomPlayer, own: AirHockeyPlayer, reason: string): void {
    own.budget.rejected++;
    const now = Date.now();
    if (now - own.budget.lastReport < 5000) return;
    own.budget.lastReport = now;

    const count = own.budget.rejected;
    own.budget.rejected = 0;
    void this.record("input_rejected", { reason, count }, player);
  }

  // -------------------------------------------------------------------------
  // Bucle de simulacion
  // -------------------------------------------------------------------------

  /** Un tick del reloj: simula y, cada TICKS_PER_SNAPSHOT, emite estado. */
  private onTick(): void {
    this.fixedUpdate(TICK_MS);
    if (this.tick % TICKS_PER_SNAPSHOT === 0) this.broadcastState();
  }

  private fixedUpdate(dtMs: number): void {
    const dt = dtMs / 1000;
    this.tick++;

    // Con un jugador caido, el reloj de juego se detiene. Seguir simulando
    // seria regalarle goles al que sigue conectado.
    const down = this.disconnectedPlayer();
    if (down) {
      down.reconnectMs = Math.max(0, down.reconnectMs - dtMs);
      return;
    }

    switch (this.phase) {
      case "countdown": {
        this.phaseTimer -= dtMs;
        // Los mazos ya responden durante la cuenta atras; el disco no.
        stepMalletsOnly(this.world, dt);
        if (this.phaseTimer <= 0) {
          resetForFaceoff(this.world, this.lastConceded, this.seedNumber() + this.tick);
          this.setPhase("playing");
        }
        break;
      }

      case "playing": {
        this.elapsedMs += dtMs;
        const result = step(this.world, dt);
        if (result.goalBy !== null) {
          this.onGoal(result.goalBy);
        } else if (this.elapsedMs >= MATCH_TIMEOUT_MS) {
          this.resolveByTimeout();
        }
        break;
      }

      case "goal": {
        this.phaseTimer -= dtMs;
        if (this.phaseTimer <= 0) {
          resetForFaceoff(this.world, this.lastConceded, this.seedNumber() + this.tick);
          this.setPhase("countdown", COUNTDOWN_MS);
        }
        break;
      }

      default:
        break;
    }
  }

  private onGoal(scorer: Seat): void {
    const player = this.playerAt(scorer);
    const own = player ? this.own.get(player.userId) : undefined;
    if (!player || !own) return;

    own.score++;
    this.lastConceded = scorer === 0 ? 1 : 0;

    const scores = this.currentScores();
    this.emitAll(ServerMessage.GOAL, { scorerSeat: scorer, scores });
    if (this.matchId) {
      void updateScore(this.matchId, scores[0], scores[1]);
      void this.record("goal", { seat: scorer, scores }, player);
    }

    if (own.score >= GOALS_TO_WIN) {
      void this.endMatch(player, "score");
      return;
    }

    // Congela un momento para que se vea el gol, luego cuenta regresiva.
    this.world.puck.vel = { x: 0, y: 0 };
    this.setPhase("goal", GOAL_FREEZE_MS);
  }

  /** Se acabo el tiempo: gana quien va arriba; empate = devolucion. */
  private resolveByTimeout(): void {
    const [home, away] = this.currentScores();
    if (home === away) {
      void this.abortMatch("timeout");
      return;
    }
    const winner = this.playerAt(home > away ? 0 : 1);
    if (winner) void this.endMatch(winner, "timeout");
  }

  // -------------------------------------------------------------------------
  // Emision de estado
  // -------------------------------------------------------------------------

  /**
   * Instantanea autoritativa. Es el unico canal por el que sale el estado.
   *
   * Va en binario (34 bytes) en vez de JSON (~115). A 60 Hz eso son ~2 KB/s
   * por jugador: menos ancho de banda que el JSON a 30 Hz, con el doble de
   * frecuencia de actualizacion.
   */
  private broadcastState(): void {
    const p0 = this.playerAt(0);
    const p1 = this.playerAt(1);
    const s0 = p0 ? this.own.get(p0.userId) : undefined;
    const s1 = p1 ? this.own.get(p1.userId) : undefined;

    const packet = encodeState({
      tick: this.tick,
      phase: this.phase,
      countdownMs: Math.max(0, Math.ceil(this.phaseTimer)),
      puck: {
        x: this.world.puck.pos.x,
        y: this.world.puck.pos.y,
        vx: this.world.puck.vel.x,
        vy: this.world.puck.vel.y,
      },
      mallets: [
        { x: this.world.mallets[0].pos.x, y: this.world.mallets[0].pos.y, ackSeq: s0?.ackSeq ?? 0 },
        { x: this.world.mallets[1].pos.x, y: this.world.mallets[1].pos.y, ackSeq: s1?.ackSeq ?? 0 },
      ],
      scores: this.currentScores(),
      connected: [p0?.connected ?? false, p1?.connected ?? false],
      reconnectMs: [Math.ceil(p0?.reconnectMs ?? 0), Math.ceil(p1?.reconnectMs ?? 0)],
    });

    this.emitAll(ServerMessage.STATE, packet);
  }

  // -------------------------------------------------------------------------
  // Utilidades
  // -------------------------------------------------------------------------

  private setPhase(phase: GamePhase, durationMs = 0): void {
    this.phase = phase;
    this.phaseTimer = durationMs;
  }

  private scoreOf(seat: Seat): number {
    const player = this.playerAt(seat);
    return player ? (this.own.get(player.userId)?.score ?? 0) : 0;
  }

  private seedNumber(): number {
    if (!this.match) return 0;
    return Number.parseInt(this.match.seed.slice(0, 8), 16) || 0;
  }
}
