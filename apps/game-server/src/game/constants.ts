/**
 * Coeficientes de simulacion. Viven SOLO en el servidor.
 *
 * El cliente no los necesita para nada: no simula. Mantenerlos aqui no es
 * seguridad por oscuridad (no hay secreto que proteger en un rebote), es
 * higiene arquitectonica: si un dia alguien los importa desde el navegador,
 * es senal de que la logica se fugo al cliente.
 */
export * from "@ah/shared";

/** Rebote contra las bandas. <1 para que la mesa no sea un pinball eterno. */
export const WALL_RESTITUTION = 0.94;

/** Rebote del disco contra el mazo. >1 seria energia gratis; 0.95 es firme. */
export const MALLET_RESTITUTION = 0.95;

/** Cuanta velocidad del mazo se transfiere al disco al golpearlo. */
export const MALLET_TRANSFER = 0.85;

/**
 * Friccion del aire de la mesa, como fraccion de velocidad conservada por
 * segundo. 0.86 = pierde ~14% de rapidez cada segundo si nadie la toca.
 */
export const PUCK_DAMPING_PER_SECOND = 0.86;

/** Techo de velocidad del disco. Impide que rebotes en cadena lo disparen. */
export const PUCK_MAX_SPEED = 1800;

/** Por debajo de esto el disco se considera detenido. */
export const PUCK_MIN_SPEED = 2;

/**
 * Velocidad minima de salida tras un golpe. Sin esto el disco puede quedar
 * "pegado" al mazo y arrastrado, que es feo y ademas explotable.
 */
export const MIN_BOUNCE_SPEED = 120;

/** Subpasos por tick. Evita el tunelado del disco a traves del mazo. */
export const PHYSICS_SUBSTEPS = 4;

/** Profundidad de la porteria detras de la linea. */
export const GOAL_DEPTH = 40;

/** Velocidad del saque tras un gol, hacia quien lo recibio. */
export const FACEOFF_SPEED = 260;

/**
 * Margen de tolerancia al validar el objetivo del mazo. El cliente puede
 * mandar el puntero un poco fuera de la mesa (el mouse se sale); eso se
 * recorta en silencio. Mas alla del margen se considera intento de
 * manipulacion y se registra.
 */
export const TARGET_TOLERANCE = 200;
