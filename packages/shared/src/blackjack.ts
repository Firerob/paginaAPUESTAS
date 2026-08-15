/**
 * Blackjack Arena 1v1 — contrato compartido.
 *
 * ---------------------------------------------------------------------------
 * Reglas
 * ---------------------------------------------------------------------------
 * - Cada jugador arranca con BLACKJACK_LIVES vidas. Partida = varias RONDAS;
 *   cada ronda es una mano completa de blackjack. Quien pierde una ronda
 *   resta 1 vida; quien llega a 0 pierde la partida y el pozo es del rival.
 * - Reparto por ronda: 1 carta VISIBLE a cada jugador, despues 1 carta OCULTA
 *   a cada jugador (boca abajo para el rival, visible para su dueño).
 * - Blackjack natural (21 con las 2 cartas iniciales) gana la ronda en el
 *   acto: se revela la mano del rival y pierde 1 vida sin jugar turno. Si
 *   los dos sacan blackjack a la vez, empate: nadie pierde vida.
 * - Turnos: quien sale sorteado juega su mano entera (PEDIR CARTA las veces
 *   que quiera, o PLANTARSE) antes de pasarle el turno al rival. Pasarse de
 *   21 (bust) pierde la ronda en el acto y revela las dos manos.
 * - Cuando los dos se plantan sin pasarse: SHOWDOWN. Se revelan las cartas
 *   ocultas, se comparan los totales, y el menor pierde 1 vida (empate exacto
 *   no le cuesta vida a nadie). Pausa de BLACKJACK_SHOWDOWN_MS antes de
 *   limpiar la mesa y repartir la siguiente ronda.
 *
 * ---------------------------------------------------------------------------
 * Que sabe el cliente
 * ---------------------------------------------------------------------------
 * El servidor manda un estado DISTINTO a cada jugador: la carta oculta del
 * rival llega como `null` hasta que la ronda termina (bust, blackjack natural
 * o showdown) y el servidor decide revelarla. No hay forma de leerla antes:
 * la informacion no esta en el payload que le toca a ese cliente.
 *
 * ---------------------------------------------------------------------------
 * Juego limpio demostrable
 * ---------------------------------------------------------------------------
 * Una sola semilla (`crypto.randomBytes(32)`) por PARTIDA, publicada como
 * `sha256(seed)` antes de la primera carta. Cada ronda baraja un mazo de 52
 * cartas propio derivado de `deriveShuffledDeck(seed, round)` — determinista
 * y verificable, igual que las minas en mines.ts. La semilla se revela al
 * terminar la partida: cualquiera puede recalcular el mazo de cada ronda y
 * comprobar que las cartas repartidas fueron exactamente esas.
 */

import { xoshiro128 } from "./mines";

/** Vidas con las que arranca cada jugador. */
export const BLACKJACK_LIVES = 5;

/** Segundos por turno (toda la mano: pedir cuantas veces se quiera o plantarse). */
export const BLACKJACK_TURN_SECONDS = 20;

/** Ausencias seguidas antes de perder por abandono. */
export const BLACKJACK_MAX_TIMEOUTS = 2;

/** Pausa con las cartas reveladas antes de limpiar la mesa (ms). */
export const BLACKJACK_SHOWDOWN_MS = 3000;

// ---------------------------------------------------------------------------
// Cartas
// ---------------------------------------------------------------------------

/** Carta como entero 0-51: rank = carta % 13 (0=A..12=K), palo = floor(carta/13). */
export type Card = number;

const RANK_LABELS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUIT_SYMBOLS = ["♠", "♥", "♦", "♣"];
const RED_SUITS = new Set([1, 2]); // corazones, diamantes

export function cardRank(card: Card): number {
  return card % 13;
}

export function cardSuit(card: Card): number {
  return Math.floor(card / 13);
}

export function cardLabel(card: Card): string {
  return RANK_LABELS[cardRank(card)];
}

export function cardSuitSymbol(card: Card): string {
  return SUIT_SYMBOLS[cardSuit(card)];
}

export function isRedCard(card: Card): boolean {
  return RED_SUITS.has(cardSuit(card));
}

function cardPipValue(card: Card): number {
  const r = cardRank(card);
  return r === 0 ? 11 : r >= 9 ? 10 : r + 1;
}

/** Suma de la mano con ases blandos: cada As vale 11 salvo que eso se pase de 21. */
export function handTotal(cards: readonly Card[]): number {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    if (cardRank(c) === 0) aces++;
    total += cardPipValue(c);
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return total;
}

export function isBust(cards: readonly Card[]): boolean {
  return handTotal(cards) > 21;
}

/** Blackjack "natural": 21 exacto con las dos cartas iniciales. */
export function isNaturalBlackjack(cards: readonly Card[]): boolean {
  return cards.length === 2 && handTotal(cards) === 21;
}

/**
 * Baraja de 52 cartas derivada de la semilla y el numero de ronda.
 *
 * Cada ronda mezcla el primer word de la semilla con el indice de ronda
 * (XOR con una constante de mezcla): distinto mazo por ronda, pero sigue
 * siendo 100% reproducible desde (seed, round) para la verificacion.
 */
export function deriveShuffledDeck(seedHex: string, round: number): Card[] {
  const word = (i: number): number => parseInt(seedHex.slice(i * 8, i * 8 + 8), 16) >>> 0;
  const a = ((word(0) ^ Math.imul(round, 0x9e3779b1)) >>> 0) || 1;
  const b = word(1) || 2;
  const c = word(2) || 3;
  const d = ((word(3) ^ round) >>> 0) || 4;
  const next = xoshiro128(a, b, c, d);

  for (let i = 0; i < 16; i++) next();

  const deck = Array.from({ length: 52 }, (_, i) => i);
  for (let i = 51; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// ---------------------------------------------------------------------------
// Protocolo
// ---------------------------------------------------------------------------

export const BlackjackClientMessage = {
  /** Pedir otra carta. Solo valido en tu turno. */
  HIT: "blackjack:hit",
  /** Plantarse: termina tu mano de esta ronda. */
  STAND: "blackjack:stand",
} as const;

export const BlackjackServerMessage = {
  /** Estado publico, redactado por jugador (la carta oculta del rival no viaja hasta que se revela). */
  STATE: "blackjack:state",
  /** Sorteo de quien arranca la ronda. */
  ROULETTE: "blackjack:roulette",
  /** Blackjack natural: fin de ronda inmediato. */
  NATURAL: "blackjack:natural",
  /** Alguien se paso de 21: fin de ronda inmediato. */
  BUST: "blackjack:bust",
  /** Los dos se plantaron: revelacion final y comparacion de totales. */
  SHOWDOWN: "blackjack:showdown",
  /** A alguien se le agoto el turno (se planta en automatico). */
  TIMEOUT: "blackjack:timeout",
  /** Jugada rechazada por el validador. */
  REJECTED: "blackjack:rejected",
  /** Semilla revelada al terminar la partida, para verificar todas las rondas. */
  FAIRNESS: "blackjack:fairness",
} as const;

export type BlackjackPhase = "waiting" | "dealing" | "playing" | "showdown" | "finished";

export interface BlackjackState {
  phase: BlackjackPhase;
  /** Numero de ronda actual (1-based). */
  round: number;
  lives: [number, number];
  timeouts: [number, number];
  currentTurnSeat: 0 | 1;
  turnMs: number;
  /** Quien sorteo la ronda para empezar. */
  startingSeat: 0 | 1;
  /** Mis cartas, siempre completas. */
  myHand: Card[];
  /** Cartas del rival: la oculta llega `null` hasta que se revela esta ronda. */
  opponentHand: (Card | null)[];
  myTotal: number;
  /** Total de lo que se ve del rival (parcial hasta la revelacion, real despues). */
  opponentTotal: number;
  myStood: boolean;
  opponentStood: boolean;
  myBusted: boolean;
  opponentBusted: boolean;
  /** Compromiso criptografico de la semilla de la partida. */
  commit: string;
}

export interface BlackjackRoulettePayload {
  round: number;
  startingSeat: 0 | 1;
}

export interface BlackjackNaturalPayload {
  round: number;
  seat0Blackjack: boolean;
  seat1Blackjack: boolean;
  hands: [Card[], Card[]];
  /** Asiento que perdio la vida, o null si empataron en blackjack. */
  loserSeat: 0 | 1 | null;
  livesAfter: [number, number];
}

export interface BlackjackBustPayload {
  round: number;
  seat: 0 | 1;
  total: number;
  hands: [Card[], Card[]];
  livesAfter: [number, number];
}

export interface BlackjackShowdownPayload {
  round: number;
  hands: [Card[], Card[]];
  totals: [number, number];
  /** Asiento que perdio la vida, o null si empataron en puntos. */
  loserSeat: 0 | 1 | null;
  livesAfter: [number, number];
}

export interface BlackjackTimeoutPayload {
  seat: 0 | 1;
  strikes: number;
}

export interface BlackjackRejectedPayload {
  reason: "not_your_turn" | "not_playing" | "rate_limited";
}

/**
 * Prueba de juego limpio (commit-reveal), igual que en Minas.
 *
 * `sha256(seed) === commit` prueba que la semilla no cambio a mitad de
 * partida. Con `seed` y el numero de ronda, cualquiera recalcula
 * `deriveShuffledDeck(seed, round)` para cada ronda jugada y compara contra
 * las cartas que de verdad se repartieron (quedan en `match_events`).
 */
export interface BlackjackFairnessPayload {
  commit: string;
  seed: string;
  roundsPlayed: number;
}
