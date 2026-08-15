/**
 * Prueba end-to-end de la penalizacion por tiempo en Minas.
 *
 *   npm run test:afk -w @ah/game-server
 *
 * Los bots de la prueba normal juegan al instante, asi que el temporizador
 * nunca llega a expirar y todo ese camino queda sin cubrir. Aqui uno de los
 * dos jugadores NO juega nunca:
 *
 *   1. se le agota el turno -> pierde 1 vida y pasa el turno
 *   2. el rival juega, el turno vuelve
 *   3. se le agota otra vez -> 2 ausencias seguidas -> derrota por abandono
 *
 * Es un camino que mueve dinero, asi que tiene que estar verificado.
 * Dura ~25 s por los dos turnos de 10 segundos.
 */
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { io, type Socket } from "socket.io-client";
import {
  MINES_LIVES,
  MINES_MAX_TIMEOUTS,
  MinesClientMessage,
  MinesServerMessage,
  ServerMessage,
  TILE_HIDDEN,
  type MatchResultPayload,
  type MinesState,
  type MinesTimeoutPayload,
} from "@ah/shared";
import { env } from "../src/config/env";
import { issueToken } from "../src/auth/jwt";
import { closePool, pool } from "../src/db/pool";

const ANA = "00000000-0000-0000-0000-000000000001";
const BETO = "00000000-0000-0000-0000-000000000002";
const STAKE = 1000;
const SIZE = 5;
const START_BALANCE = 50000;

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
            'afk:deposit:' || unnest($1::uuid[]), '{"source":"e2e"}'::jsonb`,
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

function waitFor<T>(socket: Socket, event: string, timeoutMs = 60000): Promise<T> {
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
  const url = `http://localhost:${port}`;
  const server = await startServer(port);

  const auth = (token: string) => ({ token, game: "mines", stake: STAKE, size: SIZE });
  const ana = io(url, { transports: ["websocket"], auth: auth(issueToken(ANA, "Ana")) });
  const beto = io(url, { transports: ["websocket"], auth: auth(issueToken(BETO, "Beto")) });

  const sockets: Record<number, Socket> = {};
  let state: MinesState | null = null;
  const latest = (): MinesState | null => state;
  const timeouts: MinesTimeoutPayload[] = [];

  // Handlers antes de esperar nada: JOINED y el primer STATE llegan juntos.
  let resolveFirst: (s: MinesState) => void;
  const firstState = new Promise<MinesState>((r) => (resolveFirst = r));
  for (const socket of [ana, beto]) {
    socket.on(MinesServerMessage.STATE, (s: MinesState) => {
      state = s;
      resolveFirst(s);
    });
  }
  ana.on(MinesServerMessage.TIMEOUT, (p: MinesTimeoutPayload) => timeouts.push(p));

  try {
    const [anaJoin, betoJoin] = await Promise.all([
      waitFor<{ seat: 0 | 1 }>(ana, ServerMessage.JOINED),
      waitFor<{ seat: 0 | 1 }>(beto, ServerMessage.JOINED),
    ]);
    sockets[anaJoin.seat] = ana;
    sockets[betoJoin.seat] = beto;

    const initial = await firstState;
    // El jugador ausente es quien empieza: asi su primer turno expira ya.
    const afkSeat = initial.currentTurnSeat;
    const activeSeat = afkSeat === 0 ? 1 : 0;
    console.log(`Asiento ${afkSeat} hara de ausente; el ${activeSeat} juega normal.`);

    const results = Promise.all([
      waitFor<MatchResultPayload>(ana, ServerMessage.MATCH_RESULT, 90000),
      waitFor<MatchResultPayload>(beto, ServerMessage.MATCH_RESULT, 90000),
    ]);

    // El jugador activo juega en cuanto le toca. El otro no hace nada nunca.
    const playLoop = setInterval(() => {
      const current = latest();
      if (!current || current.phase !== "playing") return;
      if (current.currentTurnSeat !== activeSeat) return;

      const hidden = current.revealedTiles
        .map((value, index) => (value === TILE_HIDDEN ? index : -1))
        .filter((index) => index >= 0);
      if (hidden.length === 0) return;

      sockets[activeSeat].emit(MinesClientMessage.REVEAL, {
        index: hidden[crypto.randomInt(hidden.length)],
      });
    }, 300);

    const [anaResult, betoResult] = await results;
    clearInterval(playLoop);

    // -----------------------------------------------------------------------
    // Verificaciones
    // -----------------------------------------------------------------------
    const afkTimeouts = timeouts.filter((t) => t.seat === afkSeat);
    assert.ok(
      afkTimeouts.length >= MINES_MAX_TIMEOUTS,
      `esperaba al menos ${MINES_MAX_TIMEOUTS} ausencias, hubo ${afkTimeouts.length}`,
    );
    console.log(`OK penalizacion: ${afkTimeouts.length} ausencias registradas.`);

    // Cada ausencia cuesta exactamente una vida.
    for (let i = 0; i < afkTimeouts.length; i++) {
      assert.equal(
        afkTimeouts[i].livesLeft,
        MINES_LIVES - (i + 1),
        `la ausencia ${i + 1} deberia dejar ${MINES_LIVES - (i + 1)} vidas`,
      );
      assert.equal(afkTimeouts[i].strikes, i + 1, "las ausencias deben contarse consecutivas");
    }
    console.log("OK vidas: cada ausencia descuenta exactamente 1 vida.");

    // Y el rival gana por abandono.
    const afkResult = sockets[afkSeat] === ana ? anaResult : betoResult;
    const winnerResult = sockets[activeSeat] === ana ? anaResult : betoResult;

    assert.equal(afkResult.youWon, false, "el ausente no puede ganar");
    assert.equal(winnerResult.youWon, true, "el que juega gana por abandono");
    assert.equal(winnerResult.endReason, "abandon", `motivo de fin: ${winnerResult.endReason}`);
    assert.equal(winnerResult.payout, 1900);
    console.log("OK abandono: 2 ausencias seguidas y el pozo es del rival.");

    // El dinero cuadra.
    const rows = await pool.query<{ available: number; locked: number }>(
      "SELECT available, locked FROM wallets WHERE user_id = ANY($1::uuid[])",
      [[ANA, BETO, env.houseUserId]],
    );
    let total = 0;
    for (const row of rows.rows) {
      assert.equal(row.locked, 0, "quedo dinero bloqueado");
      total += row.available;
    }
    assert.equal(total, START_BALANCE * 2, "el dinero total del sistema cambio");
    console.log("OK invariante: el dinero total del sistema se conserva.");

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
  console.error("\nFALLO LA PRUEBA DE AUSENCIA:", error);
  await closePool().catch(() => undefined);
  process.exit(1);
});
