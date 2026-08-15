import {
  FIELD_HEIGHT,
  FIELD_WIDTH,
  GOAL_HALF_WIDTH,
  MALLET_RADIUS,
  PUCK_RADIUS,
  clamp,
  malletSpawn,
  stepMalletToward,
  type Seat,
} from "@ah/shared";
import {
  FACEOFF_SPEED,
  MALLET_RESTITUTION,
  MALLET_TRANSFER,
  MIN_BOUNCE_SPEED,
  PHYSICS_SUBSTEPS,
  PUCK_DAMPING_PER_SECOND,
  PUCK_MAX_SPEED,
  PUCK_MIN_SPEED,
  WALL_RESTITUTION,
} from "./constants";

/**
 * Simulacion 2D de la mesa. Funciones puras sobre un objeto `World`.
 *
 * Esta es LA unica fisica del juego. El navegador no tiene una copia, no
 * predice colisiones y no decide goles: solo dibuja lo que sale de aqui.
 *
 * Sistema de coordenadas: origen arriba-izquierda, +Y hacia abajo.
 *   - asiento 0 defiende y = FIELD_HEIGHT (abajo) y ataca el arco de arriba
 *   - asiento 1 defiende y = 0 (arriba) y ataca el arco de abajo
 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface Mallet {
  seat: Seat;
  /** Posicion real, la unica que existe para la fisica. */
  pos: Vec2;
  /** Velocidad derivada del desplazamiento real del tick anterior. */
  vel: Vec2;
  /** Objetivo pedido por el jugador, ya validado y recortado. */
  target: Vec2;
}

export interface Puck {
  pos: Vec2;
  vel: Vec2;
}

export interface World {
  puck: Puck;
  mallets: [Mallet, Mallet];
}

/** Que ocurrio durante un tick. La sala reacciona a esto. */
export interface StepResult {
  /** Asiento que anoto, o null. */
  goalBy: Seat | null;
  /** Choques disco-mazo de este tick (para efectos de sonido en el cliente). */
  hits: number;
}

// ---------------------------------------------------------------------------
// Construccion y reset
// ---------------------------------------------------------------------------

export function createWorld(): World {
  return {
    puck: { pos: { x: FIELD_WIDTH / 2, y: FIELD_HEIGHT / 2 }, vel: { x: 0, y: 0 } },
    mallets: [createMallet(0), createMallet(1)],
  };
}

function createMallet(seat: Seat): Mallet {
  const spawn = malletSpawn(seat);
  return {
    seat,
    pos: { ...spawn },
    vel: { x: 0, y: 0 },
    target: { ...spawn },
  };
}

/**
 * Coloca todo para el saque. `concededBy` es quien recibio el gol: el disco
 * sale hacia su campo, como en una mesa real.
 */
export function resetForFaceoff(world: World, concededBy: Seat | null, seed: number): void {
  world.puck.pos = { x: FIELD_WIDTH / 2, y: FIELD_HEIGHT / 2 };

  if (concededBy === null) {
    world.puck.vel = { x: 0, y: 0 };
  } else {
    // Angulo pseudoaleatorio derivado de la semilla de la partida, para que el
    // saque no sea siempre identico pero siga siendo reproducible en auditoria.
    const spread = ((seed % 1000) / 1000 - 0.5) * 0.6; // +-0.3 rad
    const dir = concededBy === 0 ? 1 : -1; // hacia abajo si el 0 recibio
    world.puck.vel = {
      x: Math.sin(spread) * FACEOFF_SPEED,
      y: Math.cos(spread) * FACEOFF_SPEED * dir,
    };
  }

  for (const mallet of world.mallets) {
    const spawn = malletSpawn(mallet.seat);
    mallet.pos = { ...spawn };
    mallet.vel = { x: 0, y: 0 };
    mallet.target = { ...spawn };
  }
}

// ---------------------------------------------------------------------------
// Validacion del input  —  el corazon del anti-cheat
// ---------------------------------------------------------------------------

export type TargetRejection = "malformed" | "out_of_bounds" | null;

/**
 * Convierte la intencion del cliente en un objetivo legal.
 *
 * Devuelve el objetivo recortado y, si hubo que recortarlo mas alla de la
 * tolerancia razonable, el motivo — que la sala registra como telemetria.
 *
 * Nota clave: esto NO limita la velocidad. Limitar la posicion objetivo no
 * sirve de nada por si solo, porque un objetivo legal al otro lado de la mesa
 * seguiria siendo un teletransporte. El limite de velocidad se aplica al
 * mover el mazo, en `integrateMallet`, que es donde no se puede esquivar.
 */
export function sanitizeTarget(
  raw: unknown,
  seat: Seat,
  tolerance: number,
): { target: Vec2 | null; rejection: TargetRejection } {
  if (typeof raw !== "object" || raw === null) {
    return { target: null, rejection: "malformed" };
  }
  const { x, y } = raw as { x?: unknown; y?: unknown };
  if (typeof x !== "number" || typeof y !== "number") {
    return { target: null, rejection: "malformed" };
  }
  // NaN e Infinity envenenan la simulacion entera: un NaN en la posicion del
  // mazo se propaga al disco y la partida queda irrecuperable.
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { target: null, rejection: "malformed" };
  }

  const minX = MALLET_RADIUS;
  const maxX = FIELD_WIDTH - MALLET_RADIUS;
  const mid = FIELD_HEIGHT / 2;
  const minY = seat === 0 ? mid + MALLET_RADIUS : MALLET_RADIUS;
  const maxY = seat === 0 ? FIELD_HEIGHT - MALLET_RADIUS : mid - MALLET_RADIUS;

  const clamped: Vec2 = { x: clamp(x, minX, maxX), y: clamp(y, minY, maxY) };

  // Fuera de la tolerancia = no es el mouse saliendose de la mesa, es un
  // cliente modificado mandando coordenadas arbitrarias.
  const outOfBounds =
    Math.abs(x - clamped.x) > tolerance || Math.abs(y - clamped.y) > tolerance;

  return { target: clamped, rejection: outOfBounds ? "out_of_bounds" : null };
}

// ---------------------------------------------------------------------------
// Integracion
// ---------------------------------------------------------------------------

/**
 * Mueve el mazo hacia su objetivo respetando la velocidad maxima.
 *
 * Aqui muere el teletransporte. Aunque el cliente pida saltar 500 unidades en
 * un tick, el mazo avanza como mucho MALLET_MAX_SPEED * dt (~23 unidades a
 * 60 Hz). Y como la velocidad se deriva del desplazamiento REAL — no de nada
 * que mande el cliente — el golpe que puede imprimirle al disco tambien queda
 * acotado. No hay ningun camino por el que un script local pegue mas fuerte.
 */
function integrateMallet(mallet: Mallet, dt: number): void {
  const prevX = mallet.pos.x;
  const prevY = mallet.pos.y;

  // El paso vive en @ah/shared porque el cliente lo reproduce identico para
  // predecir su propio mazo. Una sola implementacion, cero riesgo de que las
  // dos se desincronicen.
  stepMalletToward(mallet.pos, mallet.target, dt);

  mallet.vel.x = (mallet.pos.x - prevX) / dt;
  mallet.vel.y = (mallet.pos.y - prevY) / dt;
}

function applyDamping(puck: Puck, dt: number): void {
  const factor = Math.pow(PUCK_DAMPING_PER_SECOND, dt);
  puck.vel.x *= factor;
  puck.vel.y *= factor;

  const speed = Math.hypot(puck.vel.x, puck.vel.y);
  if (speed < PUCK_MIN_SPEED) {
    puck.vel.x = 0;
    puck.vel.y = 0;
  } else if (speed > PUCK_MAX_SPEED) {
    const scale = PUCK_MAX_SPEED / speed;
    puck.vel.x *= scale;
    puck.vel.y *= scale;
  }
}

/** Bandas laterales y fondos. Devuelve el asiento que anoto, si hubo gol. */
function collideWalls(puck: Puck): Seat | null {
  const r = PUCK_RADIUS;

  if (puck.pos.x - r < 0) {
    puck.pos.x = r;
    puck.vel.x = Math.abs(puck.vel.x) * WALL_RESTITUTION;
  } else if (puck.pos.x + r > FIELD_WIDTH) {
    puck.pos.x = FIELD_WIDTH - r;
    puck.vel.x = -Math.abs(puck.vel.x) * WALL_RESTITUTION;
  }

  // La boca del arco es un hueco en la banda: dentro de ella no hay rebote.
  const inMouth = Math.abs(puck.pos.x - FIELD_WIDTH / 2) <= GOAL_HALF_WIDTH - r;

  if (puck.pos.y - r < 0) {
    if (inMouth) {
      // Gol en el arco de arriba: lo anota quien ataca arriba, el asiento 0.
      if (puck.pos.y + r < 0) return 0;
    } else {
      puck.pos.y = r;
      puck.vel.y = Math.abs(puck.vel.y) * WALL_RESTITUTION;
    }
  } else if (puck.pos.y + r > FIELD_HEIGHT) {
    if (inMouth) {
      if (puck.pos.y - r > FIELD_HEIGHT) return 1;
    } else {
      puck.pos.y = FIELD_HEIGHT - r;
      puck.vel.y = -Math.abs(puck.vel.y) * WALL_RESTITUTION;
    }
  }

  return null;
}

/**
 * Colision disco-mazo.
 *
 * El mazo se trata como masa infinita: lo empuja el jugador, el disco no lo
 * frena. Se resuelve en el marco de referencia del mazo — se refleja la
 * velocidad RELATIVA y luego se le suma la del mazo — que es lo que hace que
 * un mazo en movimiento imprima velocidad y uno quieto solo rebote.
 */
function collideMallet(puck: Puck, mallet: Mallet): boolean {
  const sumRadii = PUCK_RADIUS + MALLET_RADIUS;
  let nx = puck.pos.x - mallet.pos.x;
  let ny = puck.pos.y - mallet.pos.y;
  const distSq = nx * nx + ny * ny;

  if (distSq >= sumRadii * sumRadii) return false;

  let dist = Math.sqrt(distSq);
  if (dist < 1e-6) {
    // Centros exactamente superpuestos: elige una normal arbitraria estable
    // en vez de dividir por cero.
    nx = 0;
    ny = mallet.seat === 0 ? -1 : 1;
    dist = 1;
  } else {
    nx /= dist;
    ny /= dist;
  }

  // 1. Separa: el disco sale del mazo, nunca al reves.
  puck.pos.x = mallet.pos.x + nx * (sumRadii + 0.01);
  puck.pos.y = mallet.pos.y + ny * (sumRadii + 0.01);

  // 2. Rebote en el marco del mazo.
  const relX = puck.vel.x - mallet.vel.x * MALLET_TRANSFER;
  const relY = puck.vel.y - mallet.vel.y * MALLET_TRANSFER;
  const normalSpeed = relX * nx + relY * ny;

  // Solo si se estan acercando; si ya se separan, no re-rebotar.
  if (normalSpeed < 0) {
    const impulse = -(1 + MALLET_RESTITUTION) * normalSpeed;
    puck.vel.x = relX + nx * impulse + mallet.vel.x * MALLET_TRANSFER;
    puck.vel.y = relY + ny * impulse + mallet.vel.y * MALLET_TRANSFER;
  }

  // 3. Despegue minimo: nada de disco pegado al mazo.
  const outSpeed = puck.vel.x * nx + puck.vel.y * ny;
  if (outSpeed < MIN_BOUNCE_SPEED) {
    const missing = MIN_BOUNCE_SPEED - outSpeed;
    puck.vel.x += nx * missing;
    puck.vel.y += ny * missing;
  }

  const speed = Math.hypot(puck.vel.x, puck.vel.y);
  if (speed > PUCK_MAX_SPEED) {
    const scale = PUCK_MAX_SPEED / speed;
    puck.vel.x *= scale;
    puck.vel.y *= scale;
  }

  return true;
}

/**
 * Mueve solo los mazos, dejando el disco quieto.
 *
 * Se usa durante la cuenta regresiva: los jugadores pueden colocarse, pero el
 * disco no se mueve ni se puede golpear todavia.
 */
export function stepMalletsOnly(world: World, dt: number): void {
  for (const mallet of world.mallets) {
    integrateMallet(mallet, dt);
  }
}

/**
 * Avanza la simulacion un tick fijo.
 *
 * `dt` es SIEMPRE 1/TICK_RATE, nunca el tiempo real transcurrido. Un paso fijo
 * hace la simulacion determinista y reproducible: dos servidores con los
 * mismos inputs producen la misma partida, que es lo que permite auditar una
 * disputa. Si el proceso se atrasa, se ejecutan varios ticks; nunca un tick
 * mas largo.
 */
export function step(world: World, dt: number): StepResult {
  for (const mallet of world.mallets) {
    integrateMallet(mallet, dt);
  }

  applyDamping(world.puck, dt);

  const subDt = dt / PHYSICS_SUBSTEPS;
  let hits = 0;

  for (let i = 0; i < PHYSICS_SUBSTEPS; i++) {
    world.puck.pos.x += world.puck.vel.x * subDt;
    world.puck.pos.y += world.puck.vel.y * subDt;

    for (const mallet of world.mallets) {
      if (collideMallet(world.puck, mallet)) hits++;
    }

    const goalBy = collideWalls(world.puck);
    if (goalBy !== null) {
      return { goalBy, hits };
    }
  }

  return { goalBy: null, hits };
}
