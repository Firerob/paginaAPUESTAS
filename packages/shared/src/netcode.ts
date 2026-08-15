import {
  FIELD_HEIGHT,
  FIELD_WIDTH,
  INTERPOLATION_MAX_DELAY_MS,
  INTERPOLATION_MIN_DELAY_MS,
  SNAPSHOT_RATE_MS,
  TICK_MS,
  clamp,
  type Seat,
} from "./constants";
import type { GamePhase } from "./messages";
import { seqDelta, type DecodedState } from "./protocol";
import { stepMalletToward } from "./simulation";

/**
 * Netcode del cliente.
 *
 * Tres piezas independientes:
 *
 *   NetworkClock      estima el reloj del servidor y cuanto retrasar el render
 *   SnapshotBuffer    interpola entre instantaneas sobre la LINEA DE TIEMPO
 *                     DEL SERVIDOR, no sobre la hora de llegada
 *   MalletPredictor   predice el mazo propio y lo reconcilia con el servidor
 *
 * Ninguna decide nada del juego: solo deciden que dibujar y cuando.
 */

export interface RenderState {
  tick: number;
  phase: GamePhase;
  countdownMs: number;
  puck: { x: number; y: number; vx: number; vy: number };
  mallets: [{ x: number; y: number }, { x: number; y: number }];
  scores: [number, number];
  connected: [boolean, boolean];
  reconnectMs: [number, number];
}

/** Tiempo de simulacion que representa un tick, en ms. */
const tickToServerMs = (tick: number): number => tick * TICK_MS;

// ---------------------------------------------------------------------------
// Reloj de red
// ---------------------------------------------------------------------------

const OFFSET_WINDOW = 90;
/** Con que rapidez converge el retraso de interpolacion (0-1 por muestra). */
const DELAY_SMOOTHING = 0.08;

/**
 * Estima la correspondencia entre el reloj local y el del servidor, y decide
 * cuanto pasado hay que dibujar.
 *
 * Para cada instantanea se calcula `offset = tiempoServidor - tiempoLocal`.
 * El offset REAL (sin latencia) es el maximo observado: un paquete que llega
 * tarde produce un offset menor, nunca mayor. Tomar el maximo de una ventana
 * reciente da la mejor estimacion disponible, y la dispersion contra ese
 * maximo es exactamente el jitter de entrega.
 *
 * El retraso de interpolacion se adapta a ese jitter en vez de ser un valor
 * fijo: en una conexion buena baja hasta ~33 ms, y en una mala sube sola para
 * que el buffer nunca se quede vacio (que es lo que produce los tirones).
 */
export class NetworkClock {
  private offsets: number[] = [];
  private smoothedDelay = INTERPOLATION_MIN_DELAY_MS;

  /** Registra la llegada de una instantanea. */
  observe(serverMs: number, localMs: number): void {
    this.offsets.push(serverMs - localMs);
    if (this.offsets.length > OFFSET_WINDOW) this.offsets.shift();

    const target = clamp(
      SNAPSHOT_RATE_MS + this.jitterMs,
      INTERPOLATION_MIN_DELAY_MS,
      INTERPOLATION_MAX_DELAY_MS,
    );
    // El retraso se mueve suave: cambiarlo de golpe acelera o frena
    // visiblemente todo lo que se esta interpolando.
    this.smoothedDelay += (target - this.smoothedDelay) * DELAY_SMOOTHING;
  }

  /** Tiempo de servidor estimado para un instante local dado. */
  serverTimeAt(localMs: number): number {
    return localMs + this.offset;
  }

  get offset(): number {
    if (this.offsets.length === 0) return 0;
    let max = this.offsets[0];
    for (const value of this.offsets) if (value > max) max = value;
    return max;
  }

  /**
   * Dispersion de la entrega: distancia entre el paquete menos retrasado y el
   * percentil 10 de la ventana. Se usa el p10 y no el minimo para que un solo
   * paquete atipico no infle el retraso de todo el render.
   */
  get jitterMs(): number {
    if (this.offsets.length < 8) return SNAPSHOT_RATE_MS;
    const sorted = [...this.offsets].sort((a, b) => a - b);
    const p10 = sorted[Math.floor(sorted.length * 0.1)];
    return Math.max(0, sorted[sorted.length - 1] - p10);
  }

  get interpolationDelayMs(): number {
    return this.smoothedDelay;
  }

  reset(): void {
    this.offsets = [];
    this.smoothedDelay = INTERPOLATION_MIN_DELAY_MS;
  }
}

// ---------------------------------------------------------------------------
// Buffer de instantaneas
// ---------------------------------------------------------------------------

const BUFFER_SIZE = 32;
/** Techo de extrapolacion cuando el buffer se queda corto. */
const MAX_EXTRAPOLATION_MS = 80;

interface StampedSnapshot {
  serverMs: number;
  state: DecodedState;
}

export class SnapshotBuffer {
  private snapshots: StampedSnapshot[] = [];

  push(state: DecodedState): void {
    const serverMs = tickToServerMs(state.tick);

    // Un paquete reordenado que llega despues de uno mas nuevo se descarta:
    // insertarlo haria retroceder la interpolacion.
    const newest = this.snapshots[this.snapshots.length - 1];
    if (newest && serverMs <= newest.serverMs) return;

    this.snapshots.push({ serverMs, state });
    if (this.snapshots.length > BUFFER_SIZE) this.snapshots.shift();
  }

  get latest(): DecodedState | null {
    return this.snapshots[this.snapshots.length - 1]?.state ?? null;
  }

  clear(): void {
    this.snapshots = [];
  }

  /**
   * Estado a dibujar para un instante de tiempo de servidor.
   *
   * Interpolar por `serverMs` (derivado del tick) y no por la hora de llegada
   * es lo que hace que el jitter de red desaparezca del resultado visual: dos
   * paquetes que llegan juntos siguen representando instantes separados
   * exactamente 16.67 ms de simulacion.
   */
  sample(renderServerMs: number): RenderState | null {
    if (this.snapshots.length === 0) return null;
    if (this.snapshots.length === 1) return toRenderState(this.snapshots[0].state);

    for (let i = this.snapshots.length - 1; i > 0; i--) {
      const next = this.snapshots[i];
      const prev = this.snapshots[i - 1];
      if (prev.serverMs <= renderServerMs && renderServerMs <= next.serverMs) {
        const span = next.serverMs - prev.serverMs;
        const t = span > 0 ? (renderServerMs - prev.serverMs) / span : 1;
        return interpolate(prev.state, next.state, t);
      }
    }

    const newest = this.snapshots[this.snapshots.length - 1];

    // El render se adelanto al ultimo paquete: se extrapola el disco con la
    // velocidad que mando el servidor, acotado para no inventar demasiado.
    if (renderServerMs > newest.serverMs) {
      const aheadS = Math.min(renderServerMs - newest.serverMs, MAX_EXTRAPOLATION_MS) / 1000;
      const state = toRenderState(newest.state);
      state.puck.x = clamp(state.puck.x + newest.state.puck.vx * aheadS, 0, FIELD_WIDTH);
      state.puck.y = clamp(state.puck.y + newest.state.puck.vy * aheadS, -80, FIELD_HEIGHT + 80);
      return state;
    }

    return toRenderState(this.snapshots[0].state);
  }
}

function toRenderState(state: DecodedState): RenderState {
  return {
    tick: state.tick,
    phase: state.phase,
    countdownMs: state.countdownMs,
    puck: { ...state.puck },
    mallets: [{ x: state.mallets[0].x, y: state.mallets[0].y }, { x: state.mallets[1].x, y: state.mallets[1].y }],
    scores: [...state.scores] as [number, number],
    connected: [...state.connected] as [boolean, boolean],
    reconnectMs: [...state.reconnectMs] as [number, number],
  };
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

function interpolate(a: DecodedState, b: DecodedState, t: number): RenderState {
  return {
    tick: a.tick,
    // Fase, marcador y conexion son discretos: se toma el estado del
    // fotograma que realmente se esta dibujando (el anterior), no el mas
    // nuevo. Si no, el marcador subiria antes de que el disco entre al arco.
    phase: a.phase,
    countdownMs: Math.round(lerp(a.countdownMs, b.countdownMs, t)),
    puck: {
      x: lerp(a.puck.x, b.puck.x, t),
      y: lerp(a.puck.y, b.puck.y, t),
      vx: lerp(a.puck.vx, b.puck.vx, t),
      vy: lerp(a.puck.vy, b.puck.vy, t),
    },
    mallets: [
      { x: lerp(a.mallets[0].x, b.mallets[0].x, t), y: lerp(a.mallets[0].y, b.mallets[0].y, t) },
      { x: lerp(a.mallets[1].x, b.mallets[1].x, t), y: lerp(a.mallets[1].y, b.mallets[1].y, t) },
    ],
    scores: [...a.scores] as [number, number],
    connected: [...a.connected] as [boolean, boolean],
    reconnectMs: [...a.reconnectMs] as [number, number],
  };
}

// ---------------------------------------------------------------------------
// Prediccion y reconciliacion del mazo propio
// ---------------------------------------------------------------------------

export interface PendingInput {
  seq: number;
  x: number;
  y: number;
}

/** Error por encima del cual se corrige de golpe en vez de suavizar. */
const SNAP_THRESHOLD = 60;
/** Fraccion del error residual que se absorbe por fotograma. */
const SMOOTHING_RATE = 0.25;

/**
 * Mazo propio con respuesta de 0 ms.
 *
 * El jugador ve su mazo moverse en el mismo fotograma en que mueve el puntero,
 * sin esperar la ida y vuelta al servidor. Eso NO debilita el modelo
 * server-authoritative: la posicion que cuenta para la fisica, las colisiones
 * y los goles sigue siendo la del servidor. Esto solo decide pixeles.
 *
 * El ciclo es el clasico de prediccion + reconciliacion:
 *
 *   1. Al enviar un input se aplica localmente y se guarda en la cola de
 *      pendientes con su numero de secuencia.
 *   2. Cuando llega una instantanea, se toma la posicion autoritativa, se
 *      descartan los inputs que el servidor ya confirmo (ackSeq) y se vuelven
 *      a aplicar SOLO los pendientes.
 *   3. Si tras rehacerlos la posicion coincide con la que ya se dibujaba
 *      —el caso normal— no hay correccion visible. Si difiere poco, el error
 *      se absorbe en unos fotogramas. Si difiere mucho, el servidor rechazo
 *      algo y se salta de golpe: manda el servidor.
 */
export class MalletPredictor {
  private predicted = { x: FIELD_WIDTH / 2, y: FIELD_HEIGHT / 2 };
  private pending: PendingInput[] = [];
  private smoothing = { x: 0, y: 0 };
  private initialized = false;
  private corrections = 0;
  private lastErrorMagnitude = 0;

  reset(): void {
    this.pending = [];
    this.smoothing = { x: 0, y: 0 };
    this.initialized = false;
    this.corrections = 0;
  }

  /** Aplica un input local y lo encola a la espera de confirmacion. */
  applyLocal(input: PendingInput): void {
    this.pending.push(input);
    // La cola no puede crecer sin limite si el servidor deja de confirmar.
    if (this.pending.length > 240) this.pending.shift();
    stepMalletToward(this.predicted, input, TICK_MS / 1000);
  }

  /** Reconciliacion contra el estado autoritativo. */
  reconcile(serverPos: { x: number; y: number }, ackSeq: number): void {
    if (!this.initialized) {
      this.predicted = { ...serverPos };
      this.initialized = true;
      return;
    }

    const before = { ...this.predicted };

    // Rebase sobre la verdad y reaplicacion de lo que el servidor aun no vio.
    this.predicted = { ...serverPos };
    this.pending = this.pending.filter((input) => seqDelta(input.seq, ackSeq) > 0);
    for (const input of this.pending) {
      stepMalletToward(this.predicted, input, TICK_MS / 1000);
    }

    const errorX = before.x - this.predicted.x;
    const errorY = before.y - this.predicted.y;
    const magnitude = Math.hypot(errorX, errorY);
    this.lastErrorMagnitude = magnitude;

    if (magnitude > SNAP_THRESHOLD) {
      // Divergencia grande: el servidor recorto o rechazo el movimiento.
      // Se muestra tal cual, sin disimular.
      this.smoothing = { x: 0, y: 0 };
      this.corrections++;
      return;
    }

    // Divergencia chica: se arrastra el error y se disuelve en unos
    // fotogramas, para que la correccion no se vea como un tiron.
    this.smoothing = { x: errorX, y: errorY };
  }

  /** Posicion a dibujar este fotograma. */
  render(): { x: number; y: number } {
    this.smoothing.x *= 1 - SMOOTHING_RATE;
    this.smoothing.y *= 1 - SMOOTHING_RATE;
    if (Math.abs(this.smoothing.x) < 0.05) this.smoothing.x = 0;
    if (Math.abs(this.smoothing.y) < 0.05) this.smoothing.y = 0;

    return {
      x: this.predicted.x + this.smoothing.x,
      y: this.predicted.y + this.smoothing.y,
    };
  }

  get stats(): { pending: number; corrections: number; errorPx: number } {
    return {
      pending: this.pending.length,
      corrections: this.corrections,
      errorPx: Math.round(this.lastErrorMagnitude * 10) / 10,
    };
  }
}

/** Recorta el objetivo a la mitad de cancha propia, igual que el servidor. */
export function clampTargetToOwnHalf(
  x: number,
  y: number,
  seat: Seat,
  malletRadius: number,
): { x: number; y: number } {
  const mid = FIELD_HEIGHT / 2;
  return {
    x: clamp(x, malletRadius, FIELD_WIDTH - malletRadius),
    y:
      seat === 0
        ? clamp(y, mid + malletRadius, FIELD_HEIGHT - malletRadius)
        : clamp(y, malletRadius, mid - malletRadius),
  };
}
