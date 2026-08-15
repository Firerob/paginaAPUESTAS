/**
 * Fotografia en memoria de cuanta gente esta en la cola de emparejamiento
 * AHORA MISMO, agrupada por monto de apuesta (sin distinguir juego ni
 * tamaño de tablero: lo que el lobby quiere mostrar es "cuantos hay
 * dando vueltas en la ficha de $X", no el detalle interno de las colas).
 *
 * El dueño real del dato es MatchManager (las colas viven ahi); este modulo
 * es solo el punto de lectura para la capa HTTP, igual que presence.ts.
 */
let snapshot: Record<number, number> = {};

export function setQueueSnapshot(counts: Record<number, number>): void {
  snapshot = counts;
}

export function queuedByStake(): Record<number, number> {
  return snapshot;
}
