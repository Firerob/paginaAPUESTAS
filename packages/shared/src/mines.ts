/**
 * Minas 1v1 — contrato compartido.
 *
 * ---------------------------------------------------------------------------
 * Reglas
 * ---------------------------------------------------------------------------
 * - Tablero N x N con M minas repartidas por el SERVIDOR antes de empezar.
 * - Cada jugador arranca con 3 VIDAS.
 * - Turnos estrictos: UNA casilla por turno. Al destaparla —sea lo que sea— el
 *   turno pasa inmediatamente al rival.
 * - Casilla SEGURA: aparece una gema y no pasa nada mas.
 * - MINA: explota, el jugador pierde 1 vida, y la casilla queda visible en el
 *   tablero para los dos.
 * - 10 segundos por turno. Si se agotan, ese jugador pierde 1 vida por
 *   ausencia y pasa el turno. Dos ausencias seguidas y pierde por abandono.
 * - Fin: quien llega a 0 vidas pierde y el pozo es del rival. Si se despejan
 *   todas las casillas seguras antes, gana quien conserve MAS vidas; empate a
 *   vidas se anula y se devuelven las apuestas.
 *
 * ---------------------------------------------------------------------------
 * Es azar puro, y a proposito
 * ---------------------------------------------------------------------------
 * NO hay numeros de minas adyacentes. Ninguna casilla revela informacion sobre
 * sus vecinas, asi que no existe deduccion posible: cada eleccion es una
 * apuesta a ciegas contra la proporcion de minas que queda en el tablero.
 *
 * Eso tiene una consecuencia que conviene tener presente: al no haber
 * habilidad, el resultado depende solo de la suerte y del reloj. Es un juego
 * de azar en sentido estricto, no de destreza — lo que importa para como se
 * clasifica ante el regulador.
 *
 * ---------------------------------------------------------------------------
 * Que sabe el cliente
 * ---------------------------------------------------------------------------
 * La matriz de minas vive SOLO en la memoria del servidor. El cliente recibe
 * `revealedTiles`, donde todo lo no destapado vale TILE_HIDDEN. No hay forma
 * de leer una mina desde el navegador: ni parcheando el codigo, ni mirando el
 * trafico, porque la informacion no esta ahi hasta que el servidor la revela.
 */

/** Casilla todavia sin destapar. */
export const TILE_HIDDEN = -1;
/** Casilla destapada, sin mina. */
export const TILE_SAFE = 0;
/** Casilla destapada, con mina. */
export const TILE_MINE = 1;

export type TileState = typeof TILE_HIDDEN | typeof TILE_SAFE | typeof TILE_MINE;

/** Tamaños de tablero permitidos. El cliente elige de esta lista. */
export const MINES_SIZES = [5, 6, 8] as const;
export type MinesSize = (typeof MINES_SIZES)[number];

/** Vidas con las que arranca cada jugador. */
export const MINES_LIVES = 3;

/** Segundos por turno. */
export const MINES_TURN_SECONDS = 10;

/** Ausencias seguidas antes de perder por abandono. */
export const MINES_MAX_TIMEOUTS = 2;

/** Pausa tras destapar, para que la animacion se vea antes del cambio de turno. */
export const MINES_REVEAL_DELAY_MS = 450;

/**
 * Minas por tamaño de tablero.
 *
 * Proporcion de ~20%: con 3 vidas por jugador, suficiente para que la partida
 * se decida en pocos turnos sin que la primera eleccion sea una moneda al aire.
 */
export function minesFor(size: MinesSize): number {
  return { 5: 5, 6: 7, 8: 12 }[size];
}

export const MinesClientMessage = {
  /** Destapar la casilla `index`. Unica accion del juego. */
  REVEAL: "mines:reveal",
} as const;

export const MinesServerMessage = {
  /** Estado publico completo. Se emite en cada cambio, no en bucle. */
  STATE: "mines:state",
  /** Una casilla se destapo y era segura. */
  SAFE: "mines:safe",
  /** Una casilla se destapo y era mina. */
  EXPLODED: "mines:exploded",
  /** A alguien se le agoto el turno. */
  TIMEOUT: "mines:timeout",
  /** Jugada rechazada por el validador. */
  REJECTED: "mines:rejected",
  /** Semilla revelada al terminar, para verificar el tablero. */
  FAIRNESS: "mines:fairness",
} as const;

export type MinesPhase = "waiting" | "escrow" | "playing" | "finished";

export interface MinesState {
  phase: MinesPhase;
  size: number;
  mines: number;
  /** `size * size` casillas: TILE_HIDDEN, TILE_SAFE o TILE_MINE. */
  revealedTiles: number[];
  /** Quien destapo cada casilla: -1 nadie, 0 o 1 el asiento. */
  owners: number[];
  /** Vidas restantes por asiento. */
  lives: [number, number];
  /** Ausencias consecutivas por asiento. */
  timeouts: [number, number];
  /** A quien le toca. */
  currentTurnSeat: 0 | 1;
  /** Milisegundos restantes del turno. */
  turnMs: number;
  /** Casillas seguras que quedan por destapar. */
  safeRemaining: number;
  /** Compromiso criptografico del tablero. Ver mas abajo. */
  commit: string;
}

export interface MinesRevealPayload {
  index: number;
  seat: 0 | 1;
  /** Vidas del jugador tras la jugada. */
  livesLeft: number;
}

export interface MinesTimeoutPayload {
  seat: 0 | 1;
  livesLeft: number;
  /** Ausencias consecutivas acumuladas. */
  strikes: number;
}

export interface MinesRejectedPayload {
  reason:
    | "not_your_turn"
    | "not_playing"
    | "already_revealed"
    | "out_of_range"
    | "rate_limited";
}

/**
 * Prueba de juego limpio (commit-reveal).
 *
 * Antes de la primera jugada el servidor publica `commit`, el SHA-256 de una
 * semilla que todavia no revela. Al terminar la partida publica la semilla.
 * Cualquiera puede entonces:
 *
 *   1. comprobar que sha256(seed) === commit  → el servidor no cambio la
 *      semilla a mitad de partida;
 *   2. recalcular el tablero con `deriveMinePositions(seed, size, mines)` y
 *      verificar que coincide con las minas mostradas al final.
 *
 * Un CSPRNG por si solo prueba que el tablero es impredecible, pero no le
 * prueba nada AL JUGADOR. Esto si: convierte "confia en nosotros" en algo
 * verificable, que es justo lo que un regulador va a preguntar — y mas aun en
 * un juego que es puro azar.
 */
export interface MinesFairnessPayload {
  commit: string;
  seed: string;
  size: number;
  mines: number;
  positions: number[];
}

/**
 * Generador determinista xoshiro128**.
 *
 * Convierte la semilla en un tablero de forma reproducible. La
 * imprevisibilidad no viene de aqui — viene de que la semilla se genera con
 * `crypto.randomBytes(32)` en el servidor y no se revela hasta el final.
 * Este PRNG solo garantiza que, dada la semilla, cualquiera llega al MISMO
 * tablero: sin eso la verificacion seria imposible.
 */
export function xoshiro128(a: number, b: number, c: number, d: number): () => number {
  return () => {
    const t = (b << 9) >>> 0;
    let r = Math.imul(b, 5);
    r = ((r << 7) | (r >>> 25)) >>> 0;
    r = Math.imul(r, 9) >>> 0;

    c = (c ^ a) >>> 0;
    d = (d ^ b) >>> 0;
    b = (b ^ c) >>> 0;
    a = (a ^ d) >>> 0;
    c = (c ^ t) >>> 0;
    d = ((d << 11) | (d >>> 21)) >>> 0;

    return r / 4294967296;
  };
}

/**
 * Deriva las posiciones de las minas a partir de la semilla.
 *
 * Pura y determinista: el servidor la usa para construir el tablero y el
 * cliente para verificarlo despues. Cambiarla invalida la verificacion de las
 * partidas ya jugadas, asi que solo se toca con una version nueva del
 * protocolo.
 */
export function deriveMinePositions(seedHex: string, size: number, mines: number): number[] {
  const total = size * size;
  if (mines >= total) throw new Error("mas minas que casillas");

  // 128 bits de la semilla alimentan el generador. C(64,12) ronda 1e12
  // tableros posibles, muy por debajo de 2^128: la semilla no es el cuello
  // de botella.
  const word = (i: number): number => parseInt(seedHex.slice(i * 8, i * 8 + 8), 16) >>> 0;
  const next = xoshiro128(word(0) || 1, word(1) || 2, word(2) || 3, word(3) || 4);

  // Se descartan las primeras salidas: los generadores de esta familia
  // necesitan unas vueltas para mezclar el estado inicial.
  for (let i = 0; i < 16; i++) next();

  const indices = Array.from({ length: total }, (_, i) => i);
  // Fisher-Yates: cada permutacion es igual de probable.
  for (let i = total - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }

  return indices.slice(0, mines).sort((a, b) => a - b);
}
