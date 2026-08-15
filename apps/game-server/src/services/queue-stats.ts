import type { GameType } from "@ah/shared";

/**
 * Fotografia en memoria de cuanta gente esta en la cola de emparejamiento
 * AHORA MISMO. A diferencia de la version anterior, esto SI distingue
 * juego (y, para Minas, tamaño de tablero): Air Hockey y Minas nunca
 * comparten cola entre si, asi que mostrar un numero combinado de "cuanta
 * gente apuesta $X" mezclaba dos cosas que el jugador nunca ve mezcladas.
 *
 * El dueño real del dato es MatchManager (las colas viven ahi); este modulo
 * es solo el punto de lectura para la capa HTTP, igual que presence.ts.
 */
export interface QueueSnapshot {
  /** Jugadores en cola por juego y monto de apuesta. */
  byGameStake: Record<GameType, Record<number, number>>;
  /** Jugadores en cola de Minas por tamaño de tablero (todas las apuestas). */
  minesBySize: Record<number, number>;
  /** Jugadores en cola de Minas por tamaño de tablero Y apuesta. */
  minesBySizeStake: Record<number, Record<number, number>>;
}

const EMPTY: QueueSnapshot = {
  byGameStake: { air_hockey: {}, mines: {}, blackjack: {} },
  minesBySize: {},
  minesBySizeStake: {},
};

let snapshot: QueueSnapshot = EMPTY;

export function setQueueSnapshot(next: QueueSnapshot): void {
  snapshot = next;
}

export function getQueueSnapshot(): QueueSnapshot {
  return snapshot;
}
