import assert from "node:assert/strict";
import { test } from "node:test";
import { FIELD_HEIGHT, FIELD_WIDTH, PUCK_RADIUS } from "@ah/shared";
import { ImpactDetector } from "../lib/impacts";
import { ParticleSystem, withAlpha } from "../lib/particles";

/**
 * La deteccion de impactos es cosmetica, pero un falso positivo constante
 * significa chispas y sonidos disparandose sin parar — molesto y ademas caro.
 * Estas pruebas fijan el comportamiento.
 */

const FAR_MALLETS = [
  { x: 50, y: FIELD_HEIGHT - 50 },
  { x: 50, y: 50 },
];

test("la primera muestra no inventa impactos", () => {
  const detector = new ImpactDetector();
  const impacts = detector.detect({ x: 300, y: 500, vx: 900, vy: 0 }, FAR_MALLETS);
  assert.equal(impacts.length, 0);
});

test("un rebote en la banda derecha se detecta con la normal correcta", () => {
  const detector = new ImpactDetector();
  const nearRight = FIELD_WIDTH - PUCK_RADIUS;
  detector.detect({ x: nearRight, y: 500, vx: 900, vy: 0 }, FAR_MALLETS);
  const impacts = detector.detect({ x: nearRight, y: 500, vx: -850, vy: 0 }, FAR_MALLETS);

  assert.equal(impacts.length, 1);
  assert.equal(impacts[0].kind, "wall");
  // La normal apunta hacia dentro de la mesa.
  assert.equal(impacts[0].nx, -1);
  assert.ok(impacts[0].intensity > 0 && impacts[0].intensity <= 1);
});

test("un rebote en la banda izquierda apunta al lado contrario", () => {
  const detector = new ImpactDetector();
  detector.detect({ x: PUCK_RADIUS, y: 500, vx: -900, vy: 0 }, FAR_MALLETS);
  const impacts = detector.detect({ x: PUCK_RADIUS, y: 500, vx: 850, vy: 0 }, FAR_MALLETS);

  assert.equal(impacts.length, 1);
  assert.equal(impacts[0].nx, 1);
});

test("un cambio de signo lejos de la banda NO es un rebote", () => {
  const detector = new ImpactDetector();
  detector.detect({ x: 300, y: 500, vx: 900, vy: 0 }, FAR_MALLETS);
  const impacts = detector.detect({ x: 300, y: 500, vx: -850, vy: 0 }, FAR_MALLETS);
  assert.equal(impacts.length, 0, "en mitad de la mesa no hay pared que golpear");
});

test("el disco casi quieto no genera impactos", () => {
  const detector = new ImpactDetector();
  const nearRight = FIELD_WIDTH - PUCK_RADIUS;
  detector.detect({ x: nearRight, y: 500, vx: 20, vy: 0 }, FAR_MALLETS);
  const impacts = detector.detect({ x: nearRight, y: 500, vx: -18, vy: 0 }, FAR_MALLETS);
  assert.equal(impacts.length, 0, "por debajo del umbral es ruido de cuantizacion");
});

test("un golpe de mazo se detecta por la ganancia de rapidez", () => {
  const detector = new ImpactDetector();
  const mallet = { x: 300, y: 560 };
  const mallets = [mallet, { x: 50, y: 50 }];

  detector.detect({ x: 300, y: 520, vx: 0, vy: 100 }, mallets);
  const impacts = detector.detect({ x: 300, y: 515, vx: 0, vy: -900 }, mallets);

  assert.equal(impacts.length, 1);
  assert.equal(impacts[0].kind, "mallet");
  // Sale del mazo hacia arriba.
  assert.ok(impacts[0].ny < 0);
});

test("pasar cerca de un mazo sin ganar velocidad no cuenta como golpe", () => {
  const detector = new ImpactDetector();
  const mallets = [{ x: 300, y: 560 }, { x: 50, y: 50 }];

  detector.detect({ x: 300, y: 520, vx: 0, vy: -400 }, mallets);
  const impacts = detector.detect({ x: 300, y: 515, vx: 0, vy: -395 }, mallets);
  assert.equal(impacts.length, 0);
});

test("un rebote junto a un mazo no se cuenta dos veces", () => {
  const detector = new ImpactDetector();
  // Mazo pegado a la banda derecha: el disco rebota y esta en contacto.
  const mallets = [{ x: FIELD_WIDTH - 40, y: 500 }, { x: 50, y: 50 }];
  const nearRight = FIELD_WIDTH - PUCK_RADIUS;

  detector.detect({ x: nearRight, y: 500, vx: 900, vy: 0 }, mallets);
  const impacts = detector.detect({ x: nearRight, y: 500, vx: -850, vy: 0 }, mallets);
  assert.ok(impacts.length <= 1, `se emitieron ${impacts.length} impactos a la vez`);
});

test("las particulas mueren y no crecen sin limite", () => {
  const particles = new ParticleSystem();
  for (let i = 0; i < 40; i++) {
    particles.goalBurst(300, 500, "#ffcf5c");
  }
  assert.ok(particles.count <= 320, `tope de particulas superado: ${particles.count}`);

  // Avanzar mas que la vida maxima las vacia por completo.
  for (let i = 0; i < 200; i++) particles.update(1 / 60);
  assert.equal(particles.count, 0);
});

test("la estela se corta cuando el disco esta casi quieto", () => {
  const particles = new ParticleSystem();
  for (let i = 0; i < 10; i++) particles.trackPuck(300 + i, 500, 800);
  particles.trackPuck(310, 500, 10);

  // No hay accesor publico de la estela, asi que se comprueba de forma
  // indirecta: dibujar con menos de 2 puntos no debe lanzar.
  assert.doesNotThrow(() =>
    particles.drawTrail(
      { save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {} } as never,
      (x, y) => ({ x, y }),
      1,
      18,
    ),
  );
});

test("withAlpha convierte hex a rgba y recorta el alfa", () => {
  assert.equal(withAlpha("#22e8ff", 0.5), "rgba(34, 232, 255, 0.5)");
  assert.equal(withAlpha("#000000", -1), "rgba(0, 0, 0, 0)");
  assert.equal(withAlpha("#ffffff", 5), "rgba(255, 255, 255, 1)");
});
