import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfettiSystem } from "../lib/confetti";

/**
 * El confeti es puramente cosmetico (se puede borrar el modulo entero y la
 * liquidacion seguiria siendo identica), pero igual tiene que comportarse:
 * nacer, caer con gravedad, y morir — sin fugas de memoria en una
 * celebracion que puede quedar abierta varios minutos si el jugador no
 * cierra la pantalla.
 */

test("un cañonazo produce piezas", () => {
  const confetti = new ConfettiSystem();
  assert.equal(confetti.count, 0);
  confetti.burst(800, 600);
  assert.ok(confetti.count > 0, "burst() deberia generar al menos una pieza");
});

test("la gravedad hace que las piezas caigan con el tiempo", () => {
  const confetti = new ConfettiSystem();
  confetti.burst(800, 600, 0.5, 1);

  // Acceso indirecto: se infiere la caida observando que, tras avanzar el
  // reloj, las piezas mueren al salir por debajo del viewport en vez de
  // quedar flotando para siempre.
  for (let i = 0; i < 300 && confetti.count > 0; i++) {
    confetti.update(1 / 60, 600);
  }
  assert.equal(confetti.count, 0, "toda pieza deberia terminar cayendo fuera de pantalla o expirando");
});

test("las piezas expiran por tiempo de vida, no solo por posicion", () => {
  const confetti = new ConfettiSystem();
  // Un viewport enorme para que ninguna pieza salga por abajo antes de que
  // se le acabe la vida: aisla el camino de expiracion por `life`.
  confetti.burst(800, 100000, 0.5, 20);
  const initial = confetti.count;
  assert.ok(initial > 0);

  for (let i = 0; i < 400; i++) confetti.update(1 / 60, 100000);
  assert.equal(confetti.count, 0, "las piezas deben expirar aunque no salgan del viewport");
});

test("clear() vacia el sistema de inmediato", () => {
  const confetti = new ConfettiSystem();
  confetti.burst(800, 600);
  assert.ok(confetti.count > 0);
  confetti.clear();
  assert.equal(confetti.count, 0);
});

test("drizzle() respeta la tasa pedida en promedio", () => {
  const confetti = new ConfettiSystem();
  const seconds = 4;
  for (let i = 0; i < seconds * 60; i++) {
    confetti.drizzle(800, 1 / 60, 5);
  }
  // A 5 piezas/seg durante 4s deberian haberse creado ~20; ninguna murio
  // todavia (vida minima 3.5s), asi que el conteo actual es una cota
  // razonable de lo generado.
  assert.ok(confetti.count >= 12 && confetti.count <= 28, `conteo atipico: ${confetti.count}`);
});

test("draw() no revienta con un sistema vacio ni con piezas activas", () => {
  const confetti = new ConfettiSystem();
  const stubCtx = {
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    beginPath() {},
    ellipse() {},
    fill() {},
    stroke() {},
    fillRect() {},
    createLinearGradient: () => ({ addColorStop() {} }),
    set fillStyle(_v: unknown) {},
    set strokeStyle(_v: unknown) {},
    set shadowColor(_v: unknown) {},
    set shadowBlur(_v: unknown) {},
    set lineWidth(_v: unknown) {},
    set globalAlpha(_v: unknown) {},
  } as unknown as CanvasRenderingContext2D;

  assert.doesNotThrow(() => confetti.draw(stubCtx));
  confetti.burst(800, 600, 0.5, 10);
  assert.doesNotThrow(() => confetti.draw(stubCtx));
});
