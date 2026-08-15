/**
 * Geometria y reglas publicas del juego.
 *
 * IMPORTANTE: estas constantes se comparten con el navegador SOLO para poder
 * dibujar la mesa y para que el cliente pueda predecir localmente su propio
 * mazo (cosmetica). El servidor vuelve a derivar todo desde su propia copia
 * (`apps/game-server/src/game/constants.ts` re-exporta estas mismas y agrega
 * los coeficientes de simulacion, que el cliente nunca necesita).
 *
 * Cambiar estos valores en el navegador no cambia nada: la posicion que se
 * dibuja siempre termina reconciliada contra la que envia el servidor.
 */

/** Unidades de mundo. La mesa es vertical (portrait), como una mesa real. */
export const FIELD_WIDTH = 600;
export const FIELD_HEIGHT = 1000;

export const PUCK_RADIUS = 18;
export const MALLET_RADIUS = 32;

/** Ancho de la boca del arco, centrada en X. */
export const GOAL_WIDTH = 220;
export const GOAL_HALF_WIDTH = GOAL_WIDTH / 2;

/** Frecuencia de simulacion del servidor (ticks por segundo). */
export const TICK_RATE = 60;
export const TICK_MS = 1000 / TICK_RATE;

/**
 * Cada cuantos ticks de simulacion se emite una instantanea.
 *
 * 1 = 60 Hz. Con el paquete binario de 34 bytes eso son ~2 KB/s por jugador,
 * menos de lo que gastaba el JSON a 30 Hz, asi que no hay razon para emitir
 * mas lento. Emitir desde el bucle de fisica (y no desde un temporizador
 * aparte) garantiza que cada instantanea cae en un limite exacto de tick.
 */
export const TICKS_PER_SNAPSHOT = 1;

/** Frecuencia efectiva de instantaneas, derivada del tick rate. */
export const SNAPSHOT_RATE_MS = (1000 / TICK_RATE) * TICKS_PER_SNAPSHOT;

/** Frecuencia con la que el cliente envia su intencion de movimiento. */
export const INPUT_SEND_HZ = 60;

/**
 * Retraso minimo de interpolacion, en milisegundos de tiempo de servidor.
 *
 * El cliente dibuja el pasado para poder interpolar entre dos instantaneas
 * conocidas. El retraso real se adapta al jitter medido; esto es el piso.
 */
export const INTERPOLATION_MIN_DELAY_MS = 2 * SNAPSHOT_RATE_MS;

/** Techo del retraso adaptativo, para que una red mala no lo dispare. */
export const INTERPOLATION_MAX_DELAY_MS = 150;

/** Goles necesarios para ganar la partida. */
export const GOALS_TO_WIN = 7;

/** Cuenta regresiva antes del saque inicial y despues de cada gol (ms). */
export const COUNTDOWN_MS = 3000;
export const GOAL_FREEZE_MS = 1500;

/** Ventana de reconexion antes de declarar abandono (segundos). */
export const RECONNECT_WINDOW_S = 15;

/** Tiempo maximo de una partida antes de resolver por marcador (ms). */
export const MATCH_TIMEOUT_MS = 8 * 60 * 1000;

/** Velocidad maxima del mazo, en unidades de mundo por segundo. */
export const MALLET_MAX_SPEED = 1400;

/** Techo de mensajes de input aceptados por segundo y por cliente. */
export const INPUT_RATE_LIMIT_HZ = 90;

/** Asiento 0 defiende abajo (y = FIELD_HEIGHT). Asiento 1 defiende arriba (y = 0). */
export type Seat = 0 | 1;

/** Limites verticales del mazo segun su mitad de cancha. */
export function malletYBounds(seat: Seat): { min: number; max: number } {
  const mid = FIELD_HEIGHT / 2;
  return seat === 0
    ? { min: mid + MALLET_RADIUS, max: FIELD_HEIGHT - MALLET_RADIUS }
    : { min: MALLET_RADIUS, max: mid - MALLET_RADIUS };
}

/** Posicion de saque del mazo al inicio y despues de cada gol. */
export function malletSpawn(seat: Seat): { x: number; y: number } {
  return {
    x: FIELD_WIDTH / 2,
    y: seat === 0 ? FIELD_HEIGHT * 0.8 : FIELD_HEIGHT * 0.2,
  };
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
