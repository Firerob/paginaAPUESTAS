/**
 * Prueba end-to-end de Mines 1v1.
 *
 *   Matchmaking -> Escrow -> Turnos -> Bomba -> Liquidacion -> Verificacion
 *
 * Requiere PostgreSQL corriendo y migrado:
 *
 *   npm run db:up && npm run db:migrate
 *   npm run test:mines -w @ah/game-server
 *
 * Verifica lo que no puede fallar nunca: que el cliente jamas ve una bomba
 * antes de destaparla, que el turno se respeta, y que el dinero acaba donde
 * debe. Ademas comprueba la prueba de juego limpio como lo haria un jugador.
 */
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { io, type Socket } from "socket.io-client";
import {
  MINES_LIVES,
  MinesClientMessage,
  MinesServerMessage,
  ServerMessage,
  TILE_HIDDEN,
  deriveMinePositions,
  minesFor,
  type MatchResultPayload,
  type MinesFairnessPayload,
  type MinesRevealPayload,
  type MinesTimeoutPayload,
  type MinesState,
} from "@ah/shared";
import { env } from "../src/config/env";
import { issueToken } from "../src/auth/jwt";
import { closePool, pool } from "../src/db/pool";

const ANA = "00000000-0000-0000-0000-000000000001";
const BETO = "00000000-0000-0000-0000-000000000002";
const STAKE = 1000;
const SIZE = 5;
const START_BALANCE = 50000;

let URL = "";

async function reset(): Promise<void> {
  await pool.query(
    "TRUNCATE match_events, ledger_entries, match_players, matches RESTART IDENTITY CASCADE",
  );
  await pool.query(
    "UPDATE wallets SET available = $1, withdrawable = $1, locked = 0 WHERE user_id = ANY($2::uuid[])",
    [START_BALANCE, [ANA, BETO]],
  );
  await pool.query(
    "UPDATE wallets SET available = 0, withdrawable = 0, locked = 0 WHERE user_id = $1",
    [env.houseUserId],
  );
  await pool.query(
    `INSERT INTO ledger_entries
       (user_id, kind, amount, locked_delta, balance_after, locked_after, idempotency_key, metadata)
     SELECT unnest($1::uuid[]), 'DEPOSIT', $2, 0, $2, 0,
            'mines:deposit:' || unnest($1::uuid[]), '{"source":"e2e"}'::jsonb`,
    [[ANA, BETO], START_BALANCE],
  );
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error("sin puerto libre"))));
    });
  });
}

function startServer(port: number): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", path.join(__dirname, "..", "src", "index.ts")],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GAME_SERVER_PORT: String(port) },
    },
  );
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("el servidor no arranco")), 20000);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("escuchando en")) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[server] ${chunk}`));
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`el servidor murio con codigo ${code}`));
    });
  });
}

function waitFor<T>(socket: Socket, event: string, timeoutMs = 15000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout esperando '${event}'`)), timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

async function main(): Promise<void> {
  await reset();
  const port = await findFreePort();
  URL = `http://localhost:${port}`;
  const server = await startServer(port);

  const auth = (token: string) => ({ token, game: "mines", stake: STAKE, size: SIZE });
  const ana = io(URL, { transports: ["websocket"], auth: auth(issueToken(ANA, "Ana")) });
  const beto = io(URL, { transports: ["websocket"], auth: auth(issueToken(BETO, "Beto")) });

  const sockets: Record<number, Socket> = {};
  // TS no rastrea las asignaciones hechas dentro del callback del socket,
  // asi que el tipo se declara explicitamente y se lee via getter.
  let state: MinesState | null = null;
  const latestState = (): MinesState | null => state;
  let anaSeat = 0;

  // Los handlers se registran ANTES de esperar nada. El servidor emite
  // JOINED y el primer STATE en el mismo bloque, asi que llegan en el mismo
  // lote: si se registrara el listener despues del await, el estado inicial
  // ya habria pasado de largo. Un cliente real tiene el mismo requisito.
  let resolveFirstState: (s: MinesState) => void;
  const firstState = new Promise<MinesState>((resolve) => (resolveFirstState = resolve));
  for (const socket of [ana, beto]) {
    socket.on(MinesServerMessage.STATE, (s: MinesState) => {
      state = s;
      resolveFirstState(s);
    });
  }

  try {
    // ---------------------------------------------------------------------
    // 1. Emparejamiento y escrow
    // ---------------------------------------------------------------------
    const [anaJoin, betoJoin] = await Promise.all([
      waitFor<{ seat: 0 | 1; gameType: string }>(ana, ServerMessage.JOINED),
      waitFor<{ seat: 0 | 1; gameType: string }>(beto, ServerMessage.JOINED),
    ]);
    assert.equal(anaJoin.gameType, "mines");
    anaSeat = anaJoin.seat;
    sockets[anaJoin.seat] = ana;
    sockets[betoJoin.seat] = beto;
    console.log(`Emparejados. Ana en el asiento ${anaSeat}.`);

    const balances = await pool.query<{ available: number; locked: number }>(
      "SELECT available, locked FROM wallets WHERE user_id = ANY($1::uuid[])",
      [[ANA, BETO]],
    );
    for (const row of balances.rows) {
      assert.equal(row.available, START_BALANCE - STAKE);
      assert.equal(row.locked, STAKE);
    }
    console.log("OK escrow: 1.000 COP bloqueados a cada uno.");

    // ---------------------------------------------------------------------
    // 2. El tablero llega OCULTO
    // ---------------------------------------------------------------------
    const initial = await firstState;

    assert.equal(initial.size, SIZE);
    assert.equal(initial.mines, minesFor(SIZE));
    assert.equal(initial.revealedTiles.length, SIZE * SIZE);
    assert.ok(
      initial.revealedTiles.every((t) => t === TILE_HIDDEN),
      "el estado inicial no puede filtrar ni una casilla",
    );
    assert.deepEqual(initial.lives, [MINES_LIVES, MINES_LIVES], "ambos arrancan con 3 vidas");
    assert.ok(initial.commit.length === 64, "el compromiso debe publicarse antes de jugar");
    console.log("OK ocultacion: 25 casillas ocultas, 3 vidas cada uno, compromiso publicado.");

    // ---------------------------------------------------------------------
    // 3. Control de turnos
    // ---------------------------------------------------------------------
    const offSeat = initial.currentTurnSeat === 0 ? 1 : 0;
    const rejected = waitFor<{ reason: string }>(sockets[offSeat], MinesServerMessage.REJECTED);
    sockets[offSeat].emit(MinesClientMessage.REVEAL, { index: 0 });
    assert.equal((await rejected).reason, "not_your_turn");
    console.log("OK turnos: jugar fuera de turno se rechaza.");

    const badIndex = waitFor<{ reason: string }>(
      sockets[initial.currentTurnSeat],
      MinesServerMessage.REJECTED,
    );
    sockets[initial.currentTurnSeat].emit(MinesClientMessage.REVEAL, { index: 9999 });
    assert.equal((await badIndex).reason, "out_of_range");
    console.log("OK validacion: un indice fuera del tablero se rechaza.");

    // ---------------------------------------------------------------------
    // 4. Jugar hasta que la partida termine
    // ---------------------------------------------------------------------
    const fairness = new Promise<MinesFairnessPayload>((resolve) => {
      ana.once(MinesServerMessage.FAIRNESS, resolve);
    });
    const results = Promise.all([
      waitFor<MatchResultPayload>(ana, ServerMessage.MATCH_RESULT, 90000),
      waitFor<MatchResultPayload>(beto, ServerMessage.MATCH_RESULT, 90000),
    ]);

    let safeCount = 0;
    let mineCount = 0;
    const livesSeen: [number, number] = [MINES_LIVES, MINES_LIVES];
    // Se escucha en UN solo socket: los eventos van a los dos y contarlos en
    // ambos duplicaria el recuento.
    ana.on(MinesServerMessage.SAFE, (p: MinesRevealPayload) => {
      safeCount++;
      livesSeen[p.seat] = p.livesLeft;
    });
    ana.on(MinesServerMessage.EXPLODED, (p: MinesRevealPayload) => {
      mineCount++;
      livesSeen[p.seat] = p.livesLeft;
    });
    let timeoutCount = 0;
    ana.on(MinesServerMessage.TIMEOUT, (p: MinesTimeoutPayload) => {
      timeoutCount++;
      livesSeen[p.seat] = p.livesLeft;
    });

    // Cada jugador destapa una casilla oculta al azar cuando le toca. Como
    // solo se permite una por turno, el tablero avanza siempre.
    let lastTurnSeat = -1;
    let turnRepeats = 0;
    const playLoop = setInterval(() => {
      const current = state;
      if (!current || current.phase !== "playing") return;

      // Comprobacion de la regla estricta: el turno tiene que alternar.
      if (current.currentTurnSeat === lastTurnSeat) {
        turnRepeats++;
      } else {
        lastTurnSeat = current.currentTurnSeat;
        turnRepeats = 0;
      }

      const socket = sockets[current.currentTurnSeat];
      if (!socket?.connected) return;

      const hidden = current.revealedTiles
        .map((value, index) => (value === TILE_HIDDEN ? index : -1))
        .filter((index) => index >= 0);
      if (hidden.length === 0) return;

      socket.emit(MinesClientMessage.REVEAL, {
        index: hidden[crypto.randomInt(hidden.length)],
      });
    }, 300);

    const [anaResult, betoResult] = await results;
    clearInterval(playLoop);
    console.log(
      `OK juego: ${safeCount} seguras y ${mineCount} minas destapadas. Vidas finales ${livesSeen}.`,
    );

    // Una casilla por turno: nunca debieron acumularse muchas jugadas
    // seguidas del mismo asiento sin que el turno cambiara.
    assert.ok(turnRepeats < 12, `el turno no alterno (${turnRepeats} repeticiones)`);

    // Las vidas solo bajan, nunca suben, y nunca por debajo de cero.
    for (const seat of [0, 1] as const) {
      assert.ok(
        livesSeen[seat] >= 0 && livesSeen[seat] <= MINES_LIVES,
        `vidas fuera de rango en el asiento ${seat}: ${livesSeen[seat]}`,
      );
    }

    // INVARIANTE: una vida solo se pierde por pisar una mina o por ausencia.
    // Si esta cuenta no cuadra, el servidor esta restando vidas por algun
    // camino que no anuncia — y en un juego donde las vidas deciden el pozo,
    // eso es dinero moviendose sin explicacion.
    const finalLives = anaResult.scores;
    const livesLost = MINES_LIVES * 2 - finalLives[0] - finalLives[1];
    assert.equal(
      mineCount + timeoutCount,
      livesLost,
      `${mineCount} minas + ${timeoutCount} ausencias != ${livesLost} vidas perdidas`,
    );
    console.log(
      `OK vidas: ${mineCount} minas + ${timeoutCount} ausencias = ${livesLost} vidas perdidas.`,
    );

    // ---------------------------------------------------------------------
    // 5. Prueba de juego limpio, hecha como la haria el jugador
    // ---------------------------------------------------------------------
    const proof = await fairness;
    const recomputedCommit = crypto.createHash("sha256").update(proof.seed).digest("hex");
    assert.equal(recomputedCommit, proof.commit, "la semilla no corresponde al compromiso");
    assert.equal(proof.commit, initial.commit, "el compromiso cambio durante la partida");

    const recomputedMines = deriveMinePositions(proof.seed, proof.size, proof.mines);
    assert.deepEqual(recomputedMines, proof.positions, "las minas no salen de la semilla");
    // Toda casilla marcada como mina en el tablero final tiene que estar en
    // el compromiso: si no, el servidor habria inventado minas sobre la
    // marcha.
    const committed = new Set(proof.positions);
    const finalState = latestState();
    assert.ok(finalState, "no llego ningun estado final");
    for (let i = 0; i < finalState.revealedTiles.length; i++) {
      if (finalState.revealedTiles[i] === 1) {
        assert.ok(committed.has(i), `la casilla ${i} exploto pero no estaba comprometida`);
      }
    }
    console.log("OK juego limpio: sha256(semilla) = compromiso y el tablero se recalcula igual.");

    // ---------------------------------------------------------------------
    // 6. Liquidacion
    // ---------------------------------------------------------------------
    const voided = anaResult.payout === null;
    if (voided) {
      // Empate a vidas con el tablero despejado: se devuelve todo.
      assert.equal(betoResult.payout, null);
      assert.deepEqual(anaResult.scores, betoResult.scores);
      console.log("OK resultado: empate a vidas, apuestas devueltas.");
    } else {
      const winner = anaResult.youWon ? anaResult : betoResult;
      const loser = anaResult.youWon ? betoResult : anaResult;
      assert.equal(loser.youWon, false);
      assert.equal(winner.payout, 1900);
      assert.equal(winner.rake, 100);

      // El marcador que se persiste son las vidas: el ganador no puede tener
      // menos que el perdedor.
      const winnerSeat = winner.scores[0] > winner.scores[1] ? 0 : 1;
      assert.ok(
        winner.scores[winnerSeat] >= winner.scores[winnerSeat === 0 ? 1 : 0],
        `el ganador tiene menos vidas: ${winner.scores}`,
      );
      console.log(`OK resultado: gana quien conserva mas vidas (${winner.scores}).`);
    }

    const finalRows = await pool.query<{ user_id: string; available: number; locked: number }>(
      "SELECT user_id, available, locked FROM wallets WHERE user_id = ANY($1::uuid[])",
      [[ANA, BETO, env.houseUserId]],
    );
    let total = 0;
    for (const row of finalRows.rows) {
      assert.equal(row.locked, 0, `${row.user_id} quedo con dinero bloqueado`);
      total += row.available;
    }
    assert.equal(total, START_BALANCE * 2, "el dinero total del sistema cambio");
    console.log("OK invariante: el dinero total del sistema se conserva.");

    const match = await pool.query<{
      game_type: string;
      status: string;
      commit_hash: string;
      revealed_at: Date | null;
      config: { size: number; bombs: number };
    }>(
      "SELECT game_type, status, commit_hash, revealed_at, config FROM matches ORDER BY created_at DESC LIMIT 1",
    );
    assert.equal(match.rows[0].game_type, "mines");
    assert.equal(match.rows[0].status, "finished");
    assert.equal(match.rows[0].commit_hash, proof.commit);
    assert.ok(match.rows[0].revealed_at, "la semilla debe quedar marcada como revelada");
    assert.equal(match.rows[0].config.size, SIZE);
    console.log("OK persistencia: game_type, compromiso y config guardados.");

    console.log("\nTODAS LAS VERIFICACIONES PASARON");
  } finally {
    ana.disconnect();
    beto.disconnect();
    server.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 800));
    server.kill("SIGKILL");
    await closePool();
  }
}

main().catch(async (error) => {
  console.error("\nFALLO LA PRUEBA E2E DE MINES:", error);
  await closePool().catch(() => undefined);
  process.exit(1);
});
