import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FIELD_HEIGHT,
  FIELD_WIDTH,
  INPUT_PACKET_BYTES,
  PHASE_CODES,
  STATE_PACKET_BYTES,
  decodeInput,
  decodeState,
  encodeInput,
  encodeState,
  seqDelta,
  type DecodedState,
} from "@ah/shared";

/**
 * El codec binario es el punto mas delicado del sistema: un desfase de un byte
 * no produce un error, produce valores plausibles pero equivocados. Estas
 * pruebas son la red que evita que eso llegue a una partida con dinero.
 */

function sampleState(overrides: Partial<DecodedState> = {}): DecodedState {
  return {
    tick: 12345,
    phase: "playing",
    countdownMs: 1500,
    puck: { x: 300.4, y: 500.7, vx: -420.3, vy: 1210.9 },
    mallets: [
      { x: 250.1, y: 800.2, ackSeq: 4321 },
      { x: 310.9, y: 190.4, ackSeq: 65535 },
    ],
    scores: [3, 5],
    connected: [true, false],
    reconnectMs: [0, 12000],
    ...overrides,
  };
}

test("el paquete de estado tiene el tamaño declarado", () => {
  assert.equal(encodeState(sampleState()).byteLength, STATE_PACKET_BYTES);
  assert.equal(encodeInput({ seq: 1, x: 1, y: 1 }).byteLength, INPUT_PACKET_BYTES);
});

test("codificar y decodificar un estado conserva todos los campos", () => {
  const original = sampleState();
  const decoded = decodeState(encodeState(original));
  assert.ok(decoded);

  assert.equal(decoded.tick, original.tick);
  assert.equal(decoded.phase, original.phase);
  assert.equal(decoded.countdownMs, original.countdownMs);
  assert.deepEqual(decoded.scores, original.scores);
  assert.deepEqual(decoded.connected, original.connected);
  assert.deepEqual(decoded.reconnectMs, original.reconnectMs);
  assert.equal(decoded.mallets[0].ackSeq, original.mallets[0].ackSeq);
  assert.equal(decoded.mallets[1].ackSeq, original.mallets[1].ackSeq);

  // Las posiciones viajan cuantizadas a 0.1 unidades de mundo.
  for (const [got, want] of [
    [decoded.puck.x, original.puck.x],
    [decoded.puck.y, original.puck.y],
    [decoded.puck.vx, original.puck.vx],
    [decoded.puck.vy, original.puck.vy],
    [decoded.mallets[0].x, original.mallets[0].x],
    [decoded.mallets[1].y, original.mallets[1].y],
  ] as const) {
    assert.ok(Math.abs(got - want) <= 0.05, `${got} vs ${want}`);
  }
});

test("todas las fases sobreviven al viaje", () => {
  for (const phase of PHASE_CODES) {
    const decoded = decodeState(encodeState(sampleState({ phase })));
    assert.equal(decoded?.phase, phase);
  }
});

test("el marcador completo cabe en su nibble", () => {
  for (let home = 0; home <= 7; home++) {
    for (let away = 0; away <= 7; away++) {
      const decoded = decodeState(encodeState(sampleState({ scores: [home, away] })));
      assert.deepEqual(decoded?.scores, [home, away]);
    }
  }
});

test("las cuatro combinaciones de conexion se distinguen", () => {
  for (const connected of [
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ] as Array<[boolean, boolean]>) {
    const decoded = decodeState(encodeState(sampleState({ connected })));
    assert.deepEqual(decoded?.connected, connected);
  }
});

test("los extremos del campo no se desbordan", () => {
  const extreme = sampleState({
    puck: { x: FIELD_WIDTH, y: FIELD_HEIGHT + 60, vx: 1800, vy: -1800 },
    mallets: [
      { x: 0, y: FIELD_HEIGHT, ackSeq: 0 },
      { x: FIELD_WIDTH, y: 0, ackSeq: 1 },
    ],
  });
  const decoded = decodeState(encodeState(extreme));
  assert.ok(decoded);
  assert.ok(Math.abs(decoded.puck.x - FIELD_WIDTH) <= 0.05);
  assert.ok(Math.abs(decoded.puck.y - (FIELD_HEIGHT + 60)) <= 0.05);
  assert.ok(Math.abs(decoded.puck.vx - 1800) <= 0.05);
  assert.ok(Math.abs(decoded.puck.vy + 1800) <= 0.05);
});

test("un valor absurdo se recorta en vez de envolverse", () => {
  // Sin el recorte explicito, setInt16 haria modulo 2^16 y el disco
  // apareceria en el lado contrario de la mesa.
  const decoded = decodeState(encodeState(sampleState({ puck: { x: 1e9, y: -1e9, vx: 0, vy: 0 } })));
  assert.ok(decoded);
  assert.ok(decoded.puck.x > 0, `x recortado deberia ser positivo, fue ${decoded.puck.x}`);
  assert.ok(decoded.puck.y < 0, `y recortado deberia ser negativo, fue ${decoded.puck.y}`);
});

test("NaN no corrompe el paquete", () => {
  const decoded = decodeState(encodeState(sampleState({ puck: { x: NaN, y: NaN, vx: NaN, vy: NaN } })));
  assert.ok(decoded);
  for (const v of [decoded.puck.x, decoded.puck.y, decoded.puck.vx, decoded.puck.vy]) {
    assert.ok(Number.isFinite(v));
  }
});

test("un paquete truncado o de otra version se rechaza", () => {
  const good = encodeState(sampleState());
  assert.equal(decodeState(good.slice(0, STATE_PACKET_BYTES - 1)), null);

  const wrongVersion = encodeState(sampleState());
  wrongVersion[0] = 99;
  assert.equal(decodeState(wrongVersion), null);
});

test("el input redondea al viaje y rechaza basura", () => {
  const decoded = decodeInput(encodeInput({ seq: 777, x: 123.45, y: 678.9 }));
  assert.ok(decoded);
  assert.equal(decoded.seq, 777);
  assert.ok(Math.abs(decoded.x - 123.45) <= 0.05);
  assert.ok(Math.abs(decoded.y - 678.9) <= 0.05);

  for (const bad of [null, undefined, 42, "input", { x: 1, y: 2 }, new Uint8Array(3)]) {
    assert.equal(decodeInput(bad), null);
  }
});

test("seqDelta maneja el envolvimiento de los 16 bits", () => {
  assert.equal(seqDelta(10, 5), 5);
  assert.equal(seqDelta(5, 10), -5);
  // Justo al dar la vuelta: 2 va despues de 65535, no 65533 antes.
  assert.equal(seqDelta(2, 65535), 3);
  assert.equal(seqDelta(65535, 2), -3);
  assert.equal(seqDelta(0, 0), 0);
});
