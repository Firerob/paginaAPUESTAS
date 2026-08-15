/**
 * Reloj de paso fijo para el bucle de fisica.
 *
 * ---------------------------------------------------------------------------
 * Por que no basta con setInterval
 * ---------------------------------------------------------------------------
 * Medido en este host (ver test/bench.latency.ts y la sonda de relojes):
 *
 *   setInterval(16.67)   media 27.29 ms  p95 31.56  jitter 6.35
 *   setTimeout + deriva  media 16.67 ms  p95 30.86  jitter 4.04
 *   hibrido (spin 4 ms)  media 16.69 ms  p95 27.39  jitter 3.14
 *
 * `setInterval` no solo tiene jitter: tiene la MEDIA equivocada. Pide 16.67 ms
 * y entrega 27.29, porque el temporizador del sistema operativo redondea hacia
 * arriba a su granularidad (~15.56 ms aqui) y el error se acumula en cada
 * vuelta en lugar de compensarse. El resultado es que la simulacion avanza a
 * tirones: 2 o 3 ticks de golpe cada 30-47 ms en vez de uno cada 16.67.
 *
 * Para un juego con dinero real eso es latencia de entrada regalada: un input
 * que llega justo despues de una rafaga espera hasta la siguiente.
 *
 * La solucion es fijar los limites de tick en tiempo ABSOLUTO con un reloj
 * monotonico (`process.hrtime.bigint()`) y calcular cada espera contra ese
 * calendario. Asi el error no se acumula: si un tick sale tarde, el siguiente
 * se pide antes.
 *
 * La granularidad del temporizador del sistema sigue siendo un piso duro —
 * ni `Atomics.wait` baja de 15.56 ms en este host — asi que los ultimos
 * milisegundos se esperan con `setImmediate`, que cuesta ~3% de un nucleo y
 * recorta el p95 de 30.9 a 27.4 ms.
 */

/** Milisegundos finales que se esperan girando en vez de durmiendo. */
const SPIN_THRESHOLD_MS = 4;

/** Ticks maximos que se recuperan de una vez tras una pausa larga. */
const MAX_CATCHUP_TICKS = 5;

/** Muestras de jitter que se conservan para las metricas. */
const JITTER_WINDOW = 600;

export interface ClockMetrics {
  /** Ticks ejecutados desde el arranque. */
  ticks: number;
  /** Intervalo real medio entre ticks, en ms. */
  meanIntervalMs: number;
  /** Desviacion estandar del intervalo, en ms. */
  jitterMs: number;
  /** Peor intervalo observado, en ms. */
  maxIntervalMs: number;
  /** Ticks descartados por ir demasiado atrasado. */
  droppedTicks: number;
}

export class FixedClock {
  private readonly tickNs: bigint;
  private nextTickNs = 0n;
  private lastTickNs = 0n;
  private timer: NodeJS.Timeout | null = null;
  private immediate: NodeJS.Immediate | null = null;
  private running = false;

  private tickCount = 0;
  private droppedTicks = 0;
  private intervals: number[] = [];
  private maxInterval = 0;

  constructor(
    private readonly tickMs: number,
    private readonly onTick: () => void,
  ) {
    this.tickNs = BigInt(Math.round(tickMs * 1e6));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const now = process.hrtime.bigint();
    this.lastTickNs = now;
    this.nextTickNs = now + this.tickNs;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.immediate) {
      clearImmediate(this.immediate);
      this.immediate = null;
    }
  }

  get metrics(): ClockMetrics {
    const n = this.intervals.length;
    const mean = n === 0 ? 0 : this.intervals.reduce((a, b) => a + b, 0) / n;
    const variance =
      n === 0 ? 0 : this.intervals.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n;
    return {
      ticks: this.tickCount,
      meanIntervalMs: round(mean),
      jitterMs: round(Math.sqrt(variance)),
      maxIntervalMs: round(this.maxInterval),
      droppedTicks: this.droppedTicks,
    };
  }

  /**
   * Duerme hasta cerca del proximo limite y gira los ultimos milisegundos.
   *
   * La espera se calcula siempre contra `nextTickNs` absoluto, nunca sumando
   * `tickMs` al momento actual: eso es lo que impide que la deriva se acumule.
   */
  private schedule(): void {
    if (!this.running) return;

    const remainingMs = Number(this.nextTickNs - process.hrtime.bigint()) / 1e6;

    if (remainingMs > SPIN_THRESHOLD_MS) {
      this.timer = setTimeout(() => this.fire(), remainingMs - SPIN_THRESHOLD_MS);
    } else {
      this.immediate = setImmediate(() => this.fire());
    }
  }

  private fire(): void {
    this.timer = null;
    this.immediate = null;
    if (!this.running) return;

    const now = process.hrtime.bigint();

    // Despertamos antes del limite: seguimos girando sin gastar un tick.
    if (now < this.nextTickNs) {
      this.schedule();
      return;
    }

    let ran = 0;
    while (now >= this.nextTickNs && ran < MAX_CATCHUP_TICKS) {
      const intervalMs = Number(now - this.lastTickNs) / 1e6;
      this.lastTickNs = now;
      this.recordInterval(intervalMs);

      this.tickCount++;
      this.nextTickNs += this.tickNs;
      ran++;

      try {
        this.onTick();
      } catch (error) {
        // Un fallo en un tick no puede matar el reloj: si el bucle muere, la
        // partida se congela con dinero bloqueado.
        console.error("[clock] error en el tick", error);
      }
    }

    // Todavia atrasados tras el maximo de recuperacion: se salta tiempo en vez
    // de entrar en espiral de la muerte intentando alcanzarlo.
    if (now >= this.nextTickNs) {
      let skipped = 0;
      while (now >= this.nextTickNs) {
        this.nextTickNs += this.tickNs;
        skipped++;
      }
      this.droppedTicks += skipped;
    }

    this.schedule();
  }

  private recordInterval(intervalMs: number): void {
    // El primer intervalo mide desde el arranque, no entre ticks.
    if (this.tickCount === 0) return;
    this.intervals.push(intervalMs);
    if (this.intervals.length > JITTER_WINDOW) this.intervals.shift();
    if (intervalMs > this.maxInterval) this.maxInterval = intervalMs;
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
