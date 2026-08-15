import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FIELD_HEIGHT,
  FIELD_WIDTH,
  MALLET_MAX_SPEED,
  MALLET_RADIUS,
  TICK_MS,
  computeSettlement,
} from "@ah/shared";
import { createWorld, sanitizeTarget, step } from "../src/game/physics";

const DT = TICK_MS / 1000;

test("un objetivo dentro de la mitad propia se acepta sin recorte", () => {
  const { target, rejection } = sanitizeTarget({ x: 300, y: 800 }, 0, 200);
  assert.equal(rejection, null);
  assert.deepEqual(target, { x: 300, y: 800 });
});

test("el mazo no puede cruzar a la mitad del rival", () => {
  // El asiento 0 defiende abajo; pedir y=100 es invadir el campo contrario.
  const { target } = sanitizeTarget({ x: 300, y: 100 }, 0, 200);
  assert.ok(target);
  assert.ok(target.y >= FIELD_HEIGHT / 2 + MALLET_RADIUS);
});

test("NaN e Infinity se rechazan en vez de envenenar la simulacion", () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    const { target, rejection } = sanitizeTarget({ x: bad, y: 800 }, 0, 200);
    assert.equal(target, null);
    assert.equal(rejection, "malformed");
  }
});

test("un payload sin numeros se rechaza", () => {
  for (const bad of [null, "300,800", { x: "300", y: "800" }, {}, []]) {
    const { target } = sanitizeTarget(bad, 0, 200);
    assert.equal(target, null);
  }
});

test("coordenadas muy fuera de la mesa se marcan como sospechosas", () => {
  const { target, rejection } = sanitizeTarget({ x: 99999, y: 99999 }, 0, 200);
  assert.equal(rejection, "out_of_bounds");
  // Aun asi se recorta a algo legal: no se rompe la partida por un input raro.
  assert.ok(target && target.x <= FIELD_WIDTH && target.y <= FIELD_HEIGHT);
});

test("ANTI-CHEAT: el mazo no se teletransporta aunque el cliente lo pida", () => {
  const world = createWorld();
  const mallet = world.mallets[0];
  const start = { ...mallet.pos };

  // El cliente pide saltar al otro extremo de su mitad en un solo tick.
  const { target } = sanitizeTarget({ x: 50, y: FIELD_HEIGHT - MALLET_RADIUS }, 0, 200);
  mallet.target = target!;

  step(world, DT);

  const moved = Math.hypot(mallet.pos.x - start.x, mallet.pos.y - start.y);
  const maxStep = MALLET_MAX_SPEED * DT;
  assert.ok(
    moved <= maxStep + 1e-6,
    `el mazo avanzo ${moved.toFixed(2)}, el maximo por tick es ${maxStep.toFixed(2)}`,
  );
});

test("ANTI-CHEAT: la velocidad del mazo sale del desplazamiento real", () => {
  const world = createWorld();
  const mallet = world.mallets[0];
  mallet.target = { x: 50, y: FIELD_HEIGHT - MALLET_RADIUS };

  step(world, DT);

  const speed = Math.hypot(mallet.vel.x, mallet.vel.y);
  assert.ok(
    speed <= MALLET_MAX_SPEED + 1e-6,
    `velocidad ${speed.toFixed(2)} supera el limite ${MALLET_MAX_SPEED}`,
  );
});

test("el disco no atraviesa las bandas laterales", () => {
  const world = createWorld();
  world.puck.vel = { x: 1700, y: 0 };

  for (let i = 0; i < 240; i++) {
    const result = step(world, DT);
    assert.equal(result.goalBy, null, "no deberia haber gol golpeando de lado");
    assert.ok(world.puck.pos.x >= 0 && world.puck.pos.x <= FIELD_WIDTH);
  }
});

test("el disco entrando por la boca del arco es gol", () => {
  const world = createWorld();
  world.puck.pos = { x: FIELD_WIDTH / 2, y: 120 };
  world.puck.vel = { x: 0, y: -900 };
  // Aparta los mazos para que no interfieran.
  world.mallets[1].pos = { x: 60, y: 60 };
  world.mallets[1].target = { x: 60, y: 60 };

  let scorer: number | null = null;
  for (let i = 0; i < 60 && scorer === null; i++) {
    scorer = step(world, DT).goalBy;
  }
  assert.equal(scorer, 0, "el asiento 0 ataca el arco de arriba");
});

test("el disco fuera de la boca rebota en vez de entrar", () => {
  const world = createWorld();
  world.puck.pos = { x: 40, y: 120 };
  world.puck.vel = { x: 0, y: -900 };
  world.mallets[1].pos = { x: 500, y: 60 };
  world.mallets[1].target = { x: 500, y: 60 };

  for (let i = 0; i < 60; i++) {
    assert.equal(step(world, DT).goalBy, null);
  }
  assert.ok(world.puck.pos.y > 0);
});

test("un mazo quieto no dispara el disco", () => {
  const world = createWorld();
  world.puck.pos = { x: world.mallets[0].pos.x, y: world.mallets[0].pos.y - 60 };
  world.puck.vel = { x: 0, y: 40 };

  step(world, DT);

  const speed = Math.hypot(world.puck.vel.x, world.puck.vel.y);
  // Rebota (con el despegue minimo), pero no adquiere energia desmedida.
  assert.ok(speed < 400, `velocidad tras rebote pasivo: ${speed.toFixed(1)}`);
});

test("la liquidacion cuadra exactamente: payout + rake = pot", () => {
  for (const stake of [1000, 5000, 10000, 3333, 7]) {
    for (const bps of [0, 500, 1000, 10000]) {
      const { pot, rake, payout } = computeSettlement(stake, bps);
      assert.equal(pot, stake * 2);
      assert.equal(payout + rake, pot, `no cuadra con stake=${stake} bps=${bps}`);
      assert.ok(Number.isInteger(payout) && Number.isInteger(rake));
      assert.ok(rake >= 0 && payout >= 0);
    }
  }
});

test("el redondeo del rake nunca favorece a la casa", () => {
  // stake impar => pot impar en el peor caso: el resto se lo queda el jugador.
  const { rake, payout, pot } = computeSettlement(333, 333);
  assert.ok(rake <= (pot * 333) / 10000);
  assert.equal(payout + rake, pot);
});

test("montos invalidos se rechazan en vez de producir dinero raro", () => {
  assert.throws(() => computeSettlement(0, 1000));
  assert.throws(() => computeSettlement(-100, 1000));
  assert.throws(() => computeSettlement(1000.5, 1000));
  assert.throws(() => computeSettlement(1000, 10001));
  assert.throws(() => computeSettlement(1000, -1));
});
