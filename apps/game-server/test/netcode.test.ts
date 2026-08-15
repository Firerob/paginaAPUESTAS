import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FIELD_HEIGHT,
  FIELD_WIDTH,
  MALLET_MAX_SPEED,
  MalletPredictor,
  NetworkClock,
  SnapshotBuffer,
  SNAPSHOT_RATE_MS,
  TICK_MS,
  stepMalletToward,
  type DecodedState,
} from "@ah/shared";
import { createWorld, step } from "../src/game/physics";

const DT = TICK_MS / 1000;

/**
 * Simula el lazo completo cliente <-> servidor sin red real, para verificar
 * que la reconciliacion converge en vez de pelearse consigo misma.
 */
function makeState(tick: number, mallet: { x: number; y: number }, ackSeq: number): DecodedState {
  return {
    tick,
    phase: "playing",
    countdownMs: 0,
    puck: { x: 300, y: 500, vx: 0, vy: 0 },
    mallets: [
      { x: mallet.x, y: mallet.y, ackSeq },
      { x: 300, y: 200, ackSeq: 0 },
    ],
    scores: [0, 0],
    connected: [true, true],
    reconnectMs: [0, 0],
  };
}

test("PARIDAD: el paso compartido reproduce exactamente el del servidor", () => {
  // Si estas dos divergen, la reconciliacion corregiria en cada instantanea y
  // el mazo del jugador vibraria de forma permanente.
  const world = createWorld();
  const target = { x: 120, y: FIELD_HEIGHT - 80 };
  world.mallets[0].target = target;

  const mirror = { ...world.mallets[0].pos };

  for (let i = 0; i < 40; i++) {
    step(world, DT);
    stepMalletToward(mirror, target, DT);
  }

  assert.ok(
    Math.hypot(world.mallets[0].pos.x - mirror.x, world.mallets[0].pos.y - mirror.y) < 1e-9,
    `servidor ${JSON.stringify(world.mallets[0].pos)} vs cliente ${JSON.stringify(mirror)}`,
  );
});

test("sin latencia, la prediccion coincide con el servidor y no hay correccion", () => {
  const predictor = new MalletPredictor();
  const serverPos = { x: FIELD_WIDTH / 2, y: FIELD_HEIGHT * 0.8 };
  predictor.reconcile(serverPos, 0);

  for (let seq = 1; seq <= 60; seq++) {
    const target = { x: 200, y: FIELD_HEIGHT - 100 };
    predictor.applyLocal({ seq, ...target });
    // El servidor procesa el mismo input en el mismo tick.
    stepMalletToward(serverPos, target, DT);
    predictor.reconcile(serverPos, seq);
  }

  const rendered = predictor.render();
  assert.ok(Math.hypot(rendered.x - serverPos.x, rendered.y - serverPos.y) < 0.01);
  assert.equal(predictor.stats.corrections, 0, "no deberia haber correcciones bruscas");
  assert.equal(predictor.stats.pending, 0, "la cola de pendientes deberia vaciarse");
});

test("con latencia, los inputs pendientes se rehacen y la prediccion va adelantada", () => {
  const predictor = new MalletPredictor();
  const serverPos = { x: FIELD_WIDTH / 2, y: FIELD_HEIGHT * 0.8 };
  predictor.reconcile(serverPos, 0);

  const LAG_TICKS = 6; // ~100 ms de ida
  const inFlight: Array<{ seq: number; x: number; y: number }> = [];

  // El objetivo tiene que moverse: con uno fijo, cliente y servidor terminan
  // los dos parados en el mismo punto y no hay adelanto que medir. Un jugador
  // real mueve el puntero continuamente, que es el caso que importa.
  const targetAt = (i: number) => ({ x: 300, y: 560 + i * 4 });

  let latest = targetAt(0);
  for (let seq = 1; seq <= 90; seq++) {
    latest = targetAt(seq);
    predictor.applyLocal({ seq, ...latest });
    inFlight.push({ seq, ...latest });

    // El servidor recibe lo que se envio LAG_TICKS atras.
    if (inFlight.length > LAG_TICKS) {
      const arrived = inFlight.shift()!;
      stepMalletToward(serverPos, arrived, DT);
      predictor.reconcile(serverPos, arrived.seq);
    }
  }

  const rendered = predictor.render();
  const predictedGap = Math.hypot(rendered.x - latest.x, rendered.y - latest.y);
  const serverGap = Math.hypot(serverPos.x - latest.x, serverPos.y - latest.y);

  // La prediccion esta mas cerca del objetivo actual que la posicion que el
  // servidor todavia conoce: eso es exactamente lo que hace que el jugador vea
  // su mazo responder al instante pese a la latencia.
  assert.ok(
    predictedGap < serverGap,
    `prediccion a ${predictedGap.toFixed(1)} del objetivo, servidor a ${serverGap.toFixed(1)}`,
  );
  assert.equal(predictor.stats.pending, LAG_TICKS, "deberia haber justo los inputs en vuelo");
  assert.equal(predictor.stats.corrections, 0, "no deberia haber saltos bruscos");
});

test("si el servidor rechaza el movimiento, la correccion se ve y manda el servidor", () => {
  const predictor = new MalletPredictor();
  predictor.reconcile({ x: 300, y: 800 }, 0);

  // El cliente cree que llego lejos; el servidor lo dejo donde estaba
  // (por ejemplo porque recorto un objetivo ilegal).
  for (let seq = 1; seq <= 30; seq++) {
    predictor.applyLocal({ seq, x: 100, y: 950 });
  }
  predictor.reconcile({ x: 300, y: 800 }, 30);

  const rendered = predictor.render();
  assert.ok(Math.hypot(rendered.x - 300, rendered.y - 800) < 1, "debe saltar a la verdad");
  assert.equal(predictor.stats.corrections, 1, "la correccion brusca debe quedar contada");
});

test("una divergencia chica se absorbe suave, sin salto", () => {
  const predictor = new MalletPredictor();
  predictor.reconcile({ x: 300, y: 800 }, 0);
  predictor.applyLocal({ seq: 1, x: 320, y: 800 });

  // Servidor 10 unidades a la izquierda de lo predicho: error pequeño.
  predictor.reconcile({ x: 310, y: 800 }, 1);
  assert.equal(predictor.stats.corrections, 0, "no deberia contarse como salto");

  // El primer fotograma todavia arrastra parte del error, y va cediendo.
  const first = predictor.render();
  const second = predictor.render();
  const third = predictor.render();
  const errors = [first, second, third].map((p) => Math.abs(p.x - 310));
  assert.ok(errors[0] > errors[1] && errors[1] > errors[2], `no converge: ${errors.join(", ")}`);
  assert.ok(errors[0] < 10, "el error visible nunca supera la divergencia real");
});

test("el reenvio de una secuencia vieja no hace retroceder la prediccion", () => {
  const predictor = new MalletPredictor();
  const serverPos = { x: 300, y: 800 };
  predictor.reconcile(serverPos, 0);

  for (let seq = 1; seq <= 10; seq++) predictor.applyLocal({ seq, x: 200, y: 900 });
  predictor.reconcile(serverPos, 10);
  const after = { ...predictor.render() };

  // Llega tarde una instantanea con un acuse anterior.
  predictor.reconcile(serverPos, 4);
  const later = predictor.render();

  assert.ok(
    Math.hypot(later.x - after.x, later.y - after.y) < 25,
    "un acuse viejo no deberia mover el mazo a otra parte",
  );
});

test("la cola de pendientes no crece sin limite si el servidor deja de confirmar", () => {
  const predictor = new MalletPredictor();
  predictor.reconcile({ x: 300, y: 800 }, 0);
  for (let seq = 1; seq <= 5000; seq++) {
    predictor.applyLocal({ seq: seq & 0xffff, x: 200, y: 900 });
  }
  assert.ok(predictor.stats.pending <= 240, `cola desbordada: ${predictor.stats.pending}`);
});

test("la prediccion nunca supera la velocidad maxima del mazo", () => {
  const predictor = new MalletPredictor();
  predictor.reconcile({ x: 300, y: 800 }, 0);

  let previous = predictor.render();
  for (let seq = 1; seq <= 30; seq++) {
    // Objetivo al otro extremo: el clasico intento de teletransporte.
    predictor.applyLocal({ seq, x: 40, y: FIELD_HEIGHT - 40 });
    const current = predictor.render();
    const moved = Math.hypot(current.x - previous.x, current.y - previous.y);
    assert.ok(
      moved <= MALLET_MAX_SPEED * DT + 1,
      `el mazo predicho avanzo ${moved.toFixed(2)} en un tick`,
    );
    previous = current;
  }
});

test("el buffer interpola sobre la linea de tiempo del servidor", () => {
  const buffer = new SnapshotBuffer();
  buffer.push(makeState(100, { x: 100, y: 800 }, 0));
  buffer.push(makeState(101, { x: 200, y: 800 }, 0));

  const midpoint = 100.5 * TICK_MS;
  const sampled = buffer.sample(midpoint);
  assert.ok(sampled);
  assert.ok(Math.abs(sampled.mallets[0].x - 150) < 0.01, `interpolado en ${sampled.mallets[0].x}`);
});

test("un paquete reordenado se descarta en vez de hacer retroceder el render", () => {
  const buffer = new SnapshotBuffer();
  buffer.push(makeState(100, { x: 100, y: 800 }, 0));
  buffer.push(makeState(101, { x: 200, y: 800 }, 0));
  buffer.push(makeState(99, { x: 999, y: 800 }, 0)); // llega tarde

  const sampled = buffer.sample(101 * TICK_MS);
  assert.ok(sampled);
  assert.ok(sampled.mallets[0].x < 300, "el paquete viejo no deberia haber entrado");
});

test("el marcador no se adelanta al fotograma que se esta dibujando", () => {
  const buffer = new SnapshotBuffer();
  const before = makeState(100, { x: 100, y: 800 }, 0);
  const after = makeState(101, { x: 200, y: 800 }, 0);
  after.scores = [1, 0];

  buffer.push(before);
  buffer.push(after);

  // A mitad de camino todavia se dibuja el instante anterior al gol.
  const sampled = buffer.sample(100.5 * TICK_MS);
  assert.deepEqual(sampled?.scores, [0, 0]);
});

test("el retraso de interpolacion se adapta al jitter medido", () => {
  const stable = new NetworkClock();
  for (let i = 0; i < 90; i++) {
    // Entrega perfectamente regular: sin jitter.
    stable.observe(i * SNAPSHOT_RATE_MS, i * SNAPSHOT_RATE_MS);
  }

  const jittery = new NetworkClock();
  for (let i = 0; i < 90; i++) {
    const noise = i % 2 === 0 ? 0 : 40;
    jittery.observe(i * SNAPSHOT_RATE_MS, i * SNAPSHOT_RATE_MS + noise);
  }

  assert.ok(
    jittery.interpolationDelayMs > stable.interpolationDelayMs,
    `mala ${jittery.interpolationDelayMs} deberia superar a buena ${stable.interpolationDelayMs}`,
  );
  assert.ok(stable.interpolationDelayMs <= 40, "en una red buena el retraso debe ser chico");
});
