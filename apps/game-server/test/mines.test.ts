import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { test } from "node:test";
import {
  MINES_LIVES,
  MINES_MAX_TIMEOUTS,
  MINES_SIZES,
  MINES_TURN_SECONDS,
  TILE_HIDDEN,
  TILE_MINE,
  TILE_SAFE,
  deriveMinePositions,
  minesFor,
  type MinesSize,
} from "@ah/shared";

/**
 * El tablero de Minas decide quien se queda con el pozo, y al no haber
 * habilidad de por medio la aleatoriedad es LO UNICO que sostiene la
 * legitimidad del juego. Tiene que ser: imprevisible antes de jugar,
 * reproducible despues, y perfectamente uniforme.
 */

test("cada tamaño tiene menos minas que casillas", () => {
  for (const size of MINES_SIZES) {
    const mines = minesFor(size);
    assert.ok(mines > 0 && mines < size * size, `${size}x${size} con ${mines} minas`);
  }
});

test("hay minas suficientes para que las 3 vidas puedan agotarse", () => {
  // Si el tablero tuviera menos minas que vidas, nadie podria perder por
  // vidas y la partida SIEMPRE acabaria por tablero despejado.
  for (const size of MINES_SIZES) {
    assert.ok(
      minesFor(size) >= MINES_LIVES,
      `${size}x${size} solo tiene ${minesFor(size)} minas para ${MINES_LIVES} vidas`,
    );
  }
});

test("la misma semilla produce siempre el mismo tablero", () => {
  const seed = crypto.randomBytes(32).toString("hex");
  for (const size of MINES_SIZES) {
    const a = deriveMinePositions(seed, size, minesFor(size));
    const b = deriveMinePositions(seed, size, minesFor(size));
    assert.deepEqual(a, b, "sin esto la verificacion de juego limpio seria imposible");
  }
});

test("semillas distintas producen tableros distintos", () => {
  const size: MinesSize = 5;
  const mines = minesFor(size);
  const boards = new Set<string>();
  for (let i = 0; i < 200; i++) {
    boards.add(deriveMinePositions(crypto.randomBytes(32).toString("hex"), size, mines).join(","));
  }
  // Con C(25,5) = 53130 combinaciones, 200 tiradas casi nunca repiten.
  assert.ok(boards.size > 190, `solo ${boards.size} tableros distintos de 200`);
});

test("el tablero tiene exactamente las minas pedidas, sin repetidos", () => {
  for (const size of MINES_SIZES) {
    const mines = minesFor(size);
    const positions = deriveMinePositions(crypto.randomBytes(32).toString("hex"), size, mines);
    assert.equal(positions.length, mines);
    assert.equal(new Set(positions).size, mines, "hay posiciones repetidas");
    for (const p of positions) {
      assert.ok(Number.isInteger(p) && p >= 0 && p < size * size, `posicion fuera de rango: ${p}`);
    }
  }
});

test("UNIFORMIDAD: ninguna casilla sale favorecida", () => {
  // En un juego de azar puro un sesgo aqui es el fallo mas grave posible:
  // quien note que una esquina casi nunca tiene mina juega siempre ahi.
  const size: MinesSize = 5;
  const total = size * size;
  const mines = minesFor(size);
  const runs = 20000;
  const counts = new Array<number>(total).fill(0);

  for (let i = 0; i < runs; i++) {
    for (const p of deriveMinePositions(crypto.randomBytes(32).toString("hex"), size, mines)) {
      counts[p]++;
    }
  }

  const expected = (runs * mines) / total;
  for (let i = 0; i < total; i++) {
    const deviation = Math.abs(counts[i] - expected) / expected;
    assert.ok(
      deviation < 0.1,
      `casilla ${i}: ${counts[i]} vs ${expected} esperado (${(deviation * 100).toFixed(1)}%)`,
    );
  }
});

test("PRUEBA DE JUEGO LIMPIO: el compromiso verifica el tablero", () => {
  const seed = crypto.randomBytes(32).toString("hex");
  const commit = crypto.createHash("sha256").update(seed).digest("hex");
  const size: MinesSize = 8;
  const mines = minesFor(size);
  const positions = deriveMinePositions(seed, size, mines);

  // Lo que hace el jugador al terminar la partida:
  assert.equal(crypto.createHash("sha256").update(seed).digest("hex"), commit);
  assert.deepEqual(deriveMinePositions(seed, size, mines), positions);

  // Y si el servidor hubiera intentado colar otra semilla, el hash no cuadra.
  const otherSeed = crypto.randomBytes(32).toString("hex");
  assert.notEqual(crypto.createHash("sha256").update(otherSeed).digest("hex"), commit);
});

test("pedir mas minas que casillas se rechaza en vez de colgarse", () => {
  const seed = crypto.randomBytes(32).toString("hex");
  assert.throws(() => deriveMinePositions(seed, 3, 9));
  assert.throws(() => deriveMinePositions(seed, 3, 100));
});

test("A CIEGAS: los estados de casilla son solo oculta, segura o mina", () => {
  // La regla del juego es que destapar NO da informacion sobre las vecinas.
  // Tres estados posibles y ninguno mas: en cuanto apareciera un cuarto
  // valor (un conteo), el juego dejaria de ser a ciegas.
  const states = [TILE_HIDDEN, TILE_SAFE, TILE_MINE];
  assert.equal(new Set(states).size, 3, "los tres estados tienen que ser distintos");
  assert.equal(TILE_HIDDEN, -1);
  assert.equal(TILE_SAFE, 0);
  assert.equal(TILE_MINE, 1);
});

test("las constantes de juego son las de las reglas", () => {
  assert.equal(MINES_LIVES, 3, "cada jugador arranca con 3 vidas");
  assert.equal(MINES_TURN_SECONDS, 10, "10 segundos por turno");
  assert.equal(MINES_MAX_TIMEOUTS, 2, "dos ausencias seguidas son abandono");
});

test("una partida completa siempre termina: vidas o tablero despejado", () => {
  // Simulacion de las reglas para comprobar que no existe una linea de juego
  // que deje la partida —y el dinero— colgada para siempre.
  for (let round = 0; round < 500; round++) {
    const size: MinesSize = 5;
    const total = size * size;
    const mineSet = new Set(
      deriveMinePositions(crypto.randomBytes(32).toString("hex"), size, minesFor(size)),
    );

    const lives = [MINES_LIVES, MINES_LIVES];
    const revealed = new Array<number>(total).fill(TILE_HIDDEN);
    let safeRemaining = total - mineSet.size;
    let seat = 0;
    let turns = 0;
    let finished = false;

    while (turns < total + 5) {
      turns++;
      const hidden = revealed
        .map((value, index) => (value === TILE_HIDDEN ? index : -1))
        .filter((index) => index >= 0);
      if (hidden.length === 0) break;

      const pick = hidden[crypto.randomInt(hidden.length)];
      const isMine = mineSet.has(pick);
      revealed[pick] = isMine ? TILE_MINE : TILE_SAFE;

      if (isMine) lives[seat] -= 1;
      else safeRemaining -= 1;

      if (lives[seat] <= 0 || safeRemaining <= 0) {
        finished = true;
        break;
      }
      // Una casilla por turno: el turno cambia siempre.
      seat = seat === 0 ? 1 : 0;
    }

    assert.ok(finished, `la partida ${round} no llego a una condicion de final`);
  }
});
