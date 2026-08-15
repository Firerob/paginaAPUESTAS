/**
 * Prueba end-to-end del flujo de dinero.
 *
 *   Matchmaking -> Escrow -> Abandono -> Liquidacion
 *
 * Requiere PostgreSQL corriendo y migrado:
 *
 *   npm run db:up && npm run db:migrate
 *   npm run test:e2e -w @ah/game-server
 *
 * El script levanta el servidor, conecta dos clientes reales por WebSocket,
 * y verifica contra la base que el dinero se movio exactamente como debia.
 * No verifica el juego: verifica la contabilidad, que es lo que no puede
 * fallar nunca.
 */
import assert from "node:assert/strict";
import * as net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { io, type Socket } from "socket.io-client";
import {
  COUNTDOWN_MS,
  FIELD_HEIGHT,
  FIELD_WIDTH,
  MALLET_RADIUS,
  ServerMessage,
  decodeState,
  encodeInput,
  type DecodedState,
} from "@ah/shared";
import type { MatchResultPayload } from "@ah/shared";
import { env } from "../src/config/env";
import { issueToken } from "../src/auth/jwt";
import { closePool, pool } from "../src/db/pool";

const ANA = "00000000-0000-0000-0000-000000000001";
const BETO = "00000000-0000-0000-0000-000000000002";
const STAKE = 1000;
const START_BALANCE = 50000;
let testPort = 0;
let URL = "";

interface Balance {
  available: number;
  locked: number;
}

async function balance(userId: string): Promise<Balance> {
  const { rows } = await pool.query<Balance>(
    "SELECT available, locked FROM wallets WHERE user_id = $1",
    [userId],
  );
  return rows[0];
}

/**
 * Deja a los dos jugadores en un estado conocido antes de empezar.
 *
 * Se usa TRUNCATE y no DELETE a proposito: el diario tiene triggers que
 * prohiben UPDATE y DELETE — es inmutable por diseño — y un DELETE aqui
 * fallaria. TRUNCATE no dispara triggers de fila, que es justo lo que hace
 * falta para un reset de laboratorio.
 *
 * Despues de vaciarlo hay que volver a sembrar los depositos iniciales, o el
 * diario dejaria de reconstruir los saldos y la verificacion contable del
 * final fallaria con razon.
 */
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
            'e2e:deposit:' || unnest($1::uuid[]), '{"source":"e2e"}'::jsonb`,
    [[ANA, BETO], START_BALANCE],
  );
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


/**
 * Pide al sistema operativo un puerto libre.
 *
 * Fijar un numero a mano garantiza que algun dia choque con el servidor de
 * desarrollo, con otra prueba o con un proceso olvidado — y el sintoma
 * ("el servidor murio") no dice nada del motivo real. Que lo elija el SO
 * elimina la clase entera de problema.
 */
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
    const timer = setTimeout(() => reject(new Error("el servidor no arranco a tiempo")), 20000);
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

async function main(): Promise<void> {
  await reset();
  console.log("Estado inicial restaurado.");

  testPort = await findFreePort();
  URL = `http://localhost:${testPort}`;
  const server = await startServer(testPort);
  console.log("Servidor arriba.");

  const anaSocket = io(URL, {
    transports: ["websocket"],
    auth: { token: issueToken(ANA, "Ana"), stake: STAKE },
  });
  const betoSocket = io(URL, {
    transports: ["websocket"],
    auth: { token: issueToken(BETO, "Beto"), stake: STAKE },
  });

  try {
    // ---------------------------------------------------------------------
    // 1. Matchmaking + escrow
    // ---------------------------------------------------------------------
    await Promise.all([
      waitFor(anaSocket, ServerMessage.JOINED),
      waitFor(betoSocket, ServerMessage.JOINED),
    ]);
    console.log("Emparejados.");

    const anaAfterEscrow = await balance(ANA);
    const betoAfterEscrow = await balance(BETO);

    assert.equal(anaAfterEscrow.available, START_BALANCE - STAKE, "Ana: disponible tras escrow");
    assert.equal(anaAfterEscrow.locked, STAKE, "Ana: bloqueado tras escrow");
    assert.equal(betoAfterEscrow.available, START_BALANCE - STAKE, "Beto: disponible tras escrow");
    assert.equal(betoAfterEscrow.locked, STAKE, "Beto: bloqueado tras escrow");
    console.log("OK escrow: 1.000 COP bloqueados a cada uno.");

    // ---------------------------------------------------------------------
    // 2. El bucle de simulacion corre y emite estado
    // ---------------------------------------------------------------------
    const frames: DecodedState[] = [];
    betoSocket.on(ServerMessage.STATE, (raw: unknown) => {
      const state = decodeState(raw as ArrayBuffer | ArrayBufferView);
      if (state) frames.push(state);
    });

    let inputSeq = 0;
    // Ana lleva su mazo hasta el borde de su mitad, que es lo mas cerca del
    // disco que la regla le permite: ahi lo alcanza y lo golpea.
    const pushing = setInterval(
      () =>
        anaSocket.emit(
          "input",
          encodeInput({ seq: ++inputSeq & 0xffff, x: FIELD_WIDTH / 2, y: FIELD_HEIGHT / 2 + MALLET_RADIUS }),
        ),
      1000 / 30,
    );
    await new Promise((resolve) => setTimeout(resolve, COUNTDOWN_MS + 2000));
    clearInterval(pushing);

    assert.ok(frames.length > 40, `pocas instantaneas recibidas: ${frames.length}`);
    assert.ok(
      frames.some((f) => f.phase === "countdown"),
      "nunca se vio la fase de cuenta regresiva",
    );
    assert.ok(
      frames.some((f) => f.phase === "playing"),
      "la partida nunca entro en juego",
    );
    assert.ok(
      frames[frames.length - 1].tick > frames[0].tick,
      "el tick del servidor no avanzo",
    );

    // En el saque inicial el disco arranca quieto en el centro, como en una
    // mesa real: no se mueve hasta que alguien lo golpea.
    const playing = frames.filter((f) => f.phase === "playing");
    assert.deepEqual(
      [playing[0].puck.vx, playing[0].puck.vy],
      [0, 0],
      "el disco deberia arrancar quieto en el saque inicial",
    );

    // Y tras el golpe de Ana, tiene que haberse movido.
    const puckMoved = playing.some((f) => f.puck.y !== playing[0].puck.y || f.puck.x !== playing[0].puck.x);
    assert.ok(puckMoved, "el disco no se movio tras ser golpeado");

    // El golpe lo empuja hacia el campo rival (Y decreciente), nunca hacia
    // el propio: el mazo empuja, no succiona.
    const minY = Math.min(...playing.map((f) => f.puck.y));
    assert.ok(minY < playing[0].puck.y, `el disco no avanzo hacia el rival: minY=${minY}`);

    // El mazo de Ana obedecio el input, sin salirse de su mitad.
    const anaMallet = playing[playing.length - 1].mallets[0];
    assert.ok(
      anaMallet.y >= FIELD_HEIGHT / 2,
      `el mazo del asiento 0 invadio la mitad rival: y=${anaMallet.y}`,
    );
    console.log(
      `OK simulacion: ${frames.length} instantaneas, tick ${frames[0].tick} -> ${frames[frames.length - 1].tick}.`,
    );

    // ---------------------------------------------------------------------
    // 3. Abandono voluntario de Ana -> gana Beto
    // ---------------------------------------------------------------------
    const results = Promise.all([
      waitFor<MatchResultPayload>(anaSocket, ServerMessage.MATCH_RESULT),
      waitFor<MatchResultPayload>(betoSocket, ServerMessage.MATCH_RESULT),
    ]);
    anaSocket.emit("forfeit");
    const [anaResult, betoResult] = await results;

    assert.equal(anaResult.youWon, false, "Ana no deberia ganar tras abandonar");
    assert.equal(betoResult.youWon, true, "Beto deberia ganar por abandono");
    assert.equal(betoResult.payout, 1900, "premio esperado 1.900 COP");
    assert.equal(betoResult.rake, 100, "comision esperada 100 COP (5%)");
    console.log("OK resultado: Beto gana 1.900, comision 100.");

    // ---------------------------------------------------------------------
    // 4. Verificacion contable contra la base
    // ---------------------------------------------------------------------
    const anaFinal = await balance(ANA);
    const betoFinal = await balance(BETO);
    const houseFinal = await balance(env.houseUserId);

    assert.equal(anaFinal.available, START_BALANCE - STAKE, "Ana pierde exactamente su apuesta");
    assert.equal(anaFinal.locked, 0, "Ana no queda con dinero bloqueado");
    assert.equal(betoFinal.available, START_BALANCE + 900, "Beto gana 900 netos");
    assert.equal(betoFinal.locked, 0, "Beto no queda con dinero bloqueado");
    assert.equal(houseFinal.available, 100, "la casa cobra 100 (5% de 2.000)");
    console.log("OK saldos: Ana -1.000, Beto +900, casa +100.");

    // El sistema no crea ni destruye dinero.
    const total = anaFinal.available + betoFinal.available + houseFinal.available;
    assert.equal(total, START_BALANCE * 2, "el dinero total del sistema no cambio");
    console.log("OK invariante: el dinero total del sistema se conserva.");

    // El diario tiene que cuadrar con las wallets.
    const { rows } = await pool.query<{ user_id: string; sum_amount: number; sum_locked: number }>(
      `SELECT user_id, SUM(amount)::bigint AS sum_amount, SUM(locked_delta)::bigint AS sum_locked
         FROM ledger_entries GROUP BY user_id`,
    );
    for (const row of rows) {
      const wallet = await balance(row.user_id);
      assert.equal(
        wallet.available,
        row.sum_amount,
        `el diario no cuadra con la wallet de ${row.user_id}`,
      );
      assert.equal(wallet.locked, row.sum_locked, `locked no cuadra para ${row.user_id}`);
    }
    console.log("OK auditoria: el diario reconstruye exactamente cada saldo.");

    // ---------------------------------------------------------------------
    // 5. La partida quedo cerrada y liquidada una sola vez
    // ---------------------------------------------------------------------
    const match = await pool.query<{ status: string; end_reason: string; settled_at: Date | null }>(
      "SELECT status, end_reason, settled_at FROM matches ORDER BY created_at DESC LIMIT 1",
    );
    assert.equal(match.rows[0].status, "finished");
    assert.equal(match.rows[0].end_reason, "forfeit");
    assert.ok(match.rows[0].settled_at, "la partida quedo marcada como liquidada");

    const winEntries = await pool.query(
      "SELECT count(*)::int AS n FROM ledger_entries WHERE kind = 'BET_WIN'",
    );
    assert.equal(winEntries.rows[0].n, 1, "el premio se pago exactamente una vez");
    console.log("OK idempotencia: un solo asiento de premio.");

    console.log("\nTODAS LAS VERIFICACIONES PASARON");
  } finally {
    anaSocket.disconnect();
    betoSocket.disconnect();
    server.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 800));
    server.kill("SIGKILL");
    await closePool();
  }
}

main().catch(async (error) => {
  console.error("\nFALLO LA PRUEBA E2E:", error);
  await closePool().catch(() => undefined);
  process.exit(1);
});
