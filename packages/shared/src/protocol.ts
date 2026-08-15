import type { GamePhase } from "./messages";

/**
 * Codec binario del estado y del input.
 *
 * Vive en el paquete compartido a proposito: cliente y servidor leen EL MISMO
 * archivo. Un formato binario duplicado en dos lados es la forma mas rapida de
 * corromper una partida con dinero, porque un desfase de un byte no da error —
 * da valores plausibles pero equivocados.
 *
 * Solo se usa ArrayBuffer/DataView (nada de Buffer de Node) para que el mismo
 * codigo corra en el navegador y en el servidor.
 *
 * Tamaños: estado 34 bytes (vs ~115 del JSON equivalente), input 7 bytes.
 */

export const PROTOCOL_VERSION = 1;

/** El orden define el valor numerico en el cable. No reordenar. */
export const PHASE_CODES = [
  "waiting",
  "escrow",
  "countdown",
  "playing",
  "goal",
  "finished",
] as const satisfies readonly GamePhase[];

/** Posiciones y velocidades viajan como enteros con 0.1 unidades de mundo. */
const SCALE = 10;

export const STATE_PACKET_BYTES = 34;
export const INPUT_PACKET_BYTES = 7;

/**
 * Recorta al rango de un entero de 16 bits con signo.
 *
 * DataView.setInt16 no lanza con valores fuera de rango: los envuelve en
 * modulo 2^16. Un desbordamiento silencioso teletransportaria el disco al otro
 * extremo de la mesa, asi que se recorta explicitamente.
 */
function clampI16(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const scaled = Math.round(value * SCALE);
  return scaled < -32768 ? -32768 : scaled > 32767 ? 32767 : scaled;
}

function clampU16(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const rounded = Math.round(value);
  return rounded < 0 ? 0 : rounded > 65535 ? 65535 : rounded;
}

// ---------------------------------------------------------------------------
// Estado: servidor -> cliente
// ---------------------------------------------------------------------------

export interface DecodedState {
  tick: number;
  phase: GamePhase;
  countdownMs: number;
  puck: { x: number; y: number; vx: number; vy: number };
  /** Por asiento: posicion del mazo y ultimo input que el servidor le aplico. */
  mallets: [
    { x: number; y: number; ackSeq: number },
    { x: number; y: number; ackSeq: number },
  ];
  scores: [number, number];
  connected: [boolean, boolean];
  reconnectMs: [number, number];
}

export function encodeState(state: DecodedState): Uint8Array {
  const bytes = new Uint8Array(STATE_PACKET_BYTES);
  const view = new DataView(bytes.buffer);

  view.setUint8(0, PROTOCOL_VERSION);
  const phaseCode = PHASE_CODES.indexOf(state.phase as (typeof PHASE_CODES)[number]);
  view.setUint8(1, phaseCode < 0 ? 0 : phaseCode);
  view.setUint32(2, state.tick >>> 0, true);
  view.setUint16(6, clampU16(state.countdownMs), true);

  view.setInt16(8, clampI16(state.puck.x), true);
  view.setInt16(10, clampI16(state.puck.y), true);
  view.setInt16(12, clampI16(state.puck.vx), true);
  view.setInt16(14, clampI16(state.puck.vy), true);

  view.setInt16(16, clampI16(state.mallets[0].x), true);
  view.setInt16(18, clampI16(state.mallets[0].y), true);
  view.setUint16(20, state.mallets[0].ackSeq & 0xffff, true);

  view.setInt16(22, clampI16(state.mallets[1].x), true);
  view.setInt16(24, clampI16(state.mallets[1].y), true);
  view.setUint16(26, state.mallets[1].ackSeq & 0xffff, true);

  // Los marcadores llegan como maximo a 7, asi que 4 bits alcanzan de sobra.
  view.setUint8(28, ((state.scores[0] & 0x0f) << 4) | (state.scores[1] & 0x0f));
  view.setUint8(29, (state.connected[0] ? 1 : 0) | (state.connected[1] ? 2 : 0));
  view.setUint16(30, clampU16(state.reconnectMs[0]), true);
  view.setUint16(32, clampU16(state.reconnectMs[1]), true);

  return bytes;
}

/** Devuelve null si el paquete es de otra version o esta truncado. */
export function decodeState(data: ArrayBuffer | ArrayBufferView): DecodedState | null {
  const view =
    data instanceof ArrayBuffer
      ? new DataView(data)
      : new DataView(data.buffer, data.byteOffset, data.byteLength);

  if (view.byteLength < STATE_PACKET_BYTES) return null;
  if (view.getUint8(0) !== PROTOCOL_VERSION) return null;

  const packedScores = view.getUint8(28);
  const flags = view.getUint8(29);

  return {
    tick: view.getUint32(2, true),
    phase: PHASE_CODES[view.getUint8(1)] ?? "waiting",
    countdownMs: view.getUint16(6, true),
    puck: {
      x: view.getInt16(8, true) / SCALE,
      y: view.getInt16(10, true) / SCALE,
      vx: view.getInt16(12, true) / SCALE,
      vy: view.getInt16(14, true) / SCALE,
    },
    mallets: [
      {
        x: view.getInt16(16, true) / SCALE,
        y: view.getInt16(18, true) / SCALE,
        ackSeq: view.getUint16(20, true),
      },
      {
        x: view.getInt16(22, true) / SCALE,
        y: view.getInt16(24, true) / SCALE,
        ackSeq: view.getUint16(26, true),
      },
    ],
    scores: [(packedScores >> 4) & 0x0f, packedScores & 0x0f],
    connected: [(flags & 1) !== 0, (flags & 2) !== 0],
    reconnectMs: [view.getUint16(30, true), view.getUint16(32, true)],
  };
}

// ---------------------------------------------------------------------------
// Input: cliente -> servidor
// ---------------------------------------------------------------------------

export interface DecodedInput {
  /** Numero de secuencia, envuelve en 16 bits. Base de la reconciliacion. */
  seq: number;
  x: number;
  y: number;
}

export function encodeInput(input: DecodedInput): Uint8Array {
  const bytes = new Uint8Array(INPUT_PACKET_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint16(1, input.seq & 0xffff, true);
  view.setInt16(3, clampI16(input.x), true);
  view.setInt16(5, clampI16(input.y), true);
  return bytes;
}

/**
 * Devuelve null si el paquete no es valido.
 *
 * Que el formato acote los valores a +-3276.7 no sustituye la validacion del
 * servidor: `sanitizeTarget` sigue recortando a la mitad de cancha propia y
 * marcando como sospechoso cualquier objetivo lejos de la mesa.
 */
export function decodeInput(data: unknown): DecodedInput | null {
  if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) return null;

  const view =
    data instanceof ArrayBuffer
      ? new DataView(data)
      : new DataView(
          (data as ArrayBufferView).buffer,
          (data as ArrayBufferView).byteOffset,
          (data as ArrayBufferView).byteLength,
        );

  if (view.byteLength < INPUT_PACKET_BYTES) return null;
  if (view.getUint8(0) !== PROTOCOL_VERSION) return null;

  return {
    seq: view.getUint16(1, true),
    x: view.getInt16(3, true) / SCALE,
    y: view.getInt16(5, true) / SCALE,
  };
}

/**
 * Distancia entre dos secuencias de 16 bits teniendo en cuenta el envolvimiento.
 *
 * Sin esto, cuando seq pasa de 65535 a 0 la reconciliacion creeria que el
 * servidor retrocedio 65 mil inputs y descartaria toda la cola de pendientes.
 */
export function seqDelta(a: number, b: number): number {
  return ((a - b + 32768) & 0xffff) - 32768;
}
