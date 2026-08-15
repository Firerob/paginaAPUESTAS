/**
 * Banco de medicion de latencia y ancho de banda.
 *
 *   npm run bench -w @ah/game-server
 *
 * Levanta el servidor, conecta dos clientes reales, juega unos segundos
 * moviendo el mazo, y reporta:
 *
 *   - RTT (p50 / p95 / max)
 *   - Cadencia de instantaneas: intervalo medio y jitter (desviacion estandar)
 *   - Tamaño de payload por instantanea
 *   - Ancho de banda de bajada
 *   - Latencia input -> reconocimiento del servidor (solo si el protocolo
 *     expone el numero de secuencia; en la linea base todavia no existe)
 *
 * Sirve para comparar antes/despues de una optimizacion con numeros y no con
 * sensaciones. Guarda el resultado en bench-results.json para poder diffear.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { io, type Socket } from "socket.io-client";
import {
  COUNTDOWN_MS,
  FIELD_HEIGHT,
  FIELD_WIDTH,
  ServerMessage,
  decodeState,
  encodeInput,
} from "@ah/shared";
import { env } from "../src/config/env";
import { issueToken } from "../src/auth/jwt";
import { closePool, pool } from "../src/db/pool";

const ANA = "00000000-0000-0000-0000-000000000001";
const BETO = "00000000-0000-0000-0000-000000000002";
const STAKE = 1000;
const START_BALANCE = 50000;
let testPort = 0;
let URL = "";

/** Duracion de la fase de medicion, ya en juego. */
const MEASURE_MS = 12_000;
const PING_INTERVAL_MS = 100;
const INPUT_HZ = 60;

interface Stats {
  n: number;
  mean: number;
  p50: number;
  p95: number;
  max: number;
  stdev: number;
}

function stats(values: number[]): Stats {
  if (values.length === 0) return { n: 0, mean: 0, p50: 0, p95: 0, max: 0, stdev: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const variance = sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / sorted.length;
  return {
    n: sorted.length,
    mean: round(mean),
    p50: round(sorted[Math.floor(sorted.length * 0.5)]),
    p95: round(sorted[Math.floor(sorted.length * 0.95)]),
    max: round(sorted[sorted.length - 1]),
    stdev: round(Math.sqrt(variance)),
  };
}

const round = (v: number): number => Math.round(v * 100) / 100;

async function resetBalances(): Promise<void> {
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
            'bench:deposit:' || unnest($1::uuid[]), '{"source":"bench"}'::jsonb`,
    [[ANA, BETO], START_BALANCE],
  );
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

/** Bytes del payload de aplicacion, sin contar el framing de WebSocket. */
function payloadBytes(data: unknown): number {
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  return Buffer.byteLength(JSON.stringify(data), "utf8");
}

async function main(): Promise<void> {
  await resetBalances();
  testPort = await findFreePort();
  URL = `http://localhost:${testPort}`;
  const server = await startServer(testPort);

  const ana = io(URL, { transports: ["websocket"], auth: { token: issueToken(ANA, "Ana"), stake: STAKE } });
  const beto = io(URL, { transports: ["websocket"], auth: { token: issueToken(BETO, "Beto"), stake: STAKE } });

  const rtt: number[] = [];
  const frameArrivals: number[] = [];
  const frameSizes: number[] = [];
  const inputAck: number[] = [];
  const inputSentAt = new Map<number, number>();
  let serverTickFirst = 0;
  let serverTickLast = 0;
  let protocol: "json" | "binary" = "json";

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no se emparejaron")), 15000);
      let joined = 0;
      const onJoin = (): void => {
        if (++joined === 2) {
          clearTimeout(timer);
          resolve();
        }
      };
      ana.once(ServerMessage.JOINED, onJoin);
      beto.once(ServerMessage.JOINED, onJoin);
    });

    // Espera a que termine la cuenta regresiva: medimos en juego real.
    await new Promise((r) => setTimeout(r, COUNTDOWN_MS + 500));

    ana.on(ServerMessage.PONG, (payload: { t: number }) => {
      rtt.push(performance.now() - payload.t);
    });

    ana.on(ServerMessage.STATE, (data: unknown) => {
      const arrivedAt = performance.now();
      frameArrivals.push(arrivedAt);
      frameSizes.push(payloadBytes(data));

      const state = decodeState(data as ArrayBuffer | ArrayBufferView);
      if (!state) return;
      protocol = "binary";

      if (!serverTickFirst) serverTickFirst = state.tick;
      serverTickLast = state.tick;

      // Tiempo desde que se envio un input hasta que el servidor lo reconoce
      // en una instantanea. Es la latencia que el jugador siente de verdad.
      const sentAt = inputSentAt.get(state.mallets[0].ackSeq);
      if (sentAt !== undefined) {
        inputAck.push(arrivedAt - sentAt);
        inputSentAt.clear();
      }
    });

    const pinger = setInterval(() => ana.emit("ping", { t: performance.now() }), PING_INTERVAL_MS);

    // Movimiento continuo del mazo, como un jugador real.
    let seq = 0;
    let phase = 0;
    const mover = setInterval(() => {
      phase += 0.08;
      const target = {
        x: FIELD_WIDTH / 2 + Math.sin(phase) * 180,
        y: FIELD_HEIGHT * 0.75 + Math.cos(phase * 0.7) * 120,
        seq: ++seq & 0xffff,
      };
      inputSentAt.set(target.seq, performance.now());
      ana.emit("input", encodeInput(target));
    }, 1000 / INPUT_HZ);

    console.log(`Midiendo ${MEASURE_MS / 1000}s de juego...`);
    await new Promise((r) => setTimeout(r, MEASURE_MS));
    clearInterval(pinger);
    clearInterval(mover);

    const intervals: number[] = [];
    for (let i = 1; i < frameArrivals.length; i++) {
      intervals.push(frameArrivals[i] - frameArrivals[i - 1]);
    }
    const elapsedS = (frameArrivals[frameArrivals.length - 1] - frameArrivals[0]) / 1000;
    const totalBytes = frameSizes.reduce((a, b) => a + b, 0);
    const ticksElapsed = serverTickLast - serverTickFirst;

    const result = {
      timestamp: new Date().toISOString(),
      protocol,
      rtt_ms: stats(rtt),
      snapshot_interval_ms: stats(intervals),
      snapshot_bytes: stats(frameSizes),
      input_ack_ms: inputAck.length > 0 ? stats(inputAck) : null,
      snapshots_per_second: round(frameArrivals.length / elapsedS),
      downstream_bytes_per_second: round(totalBytes / elapsedS),
      server_ticks_per_second: round(ticksElapsed / elapsedS),
    };

    console.log("\n=== RESULTADOS ===");
    console.log(JSON.stringify(result, null, 2));

    const outPath = path.join(__dirname, "..", "bench-results.json");
    const history = fs.existsSync(outPath)
      ? (JSON.parse(fs.readFileSync(outPath, "utf8")) as unknown[])
      : [];
    history.push(result);
    fs.writeFileSync(outPath, JSON.stringify(history, null, 2), "utf8");
    console.log(`\nGuardado en ${outPath} (${history.length} corridas)`);
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
  console.error("Fallo el banco de medicion:", error);
  await closePool().catch(() => undefined);
  process.exit(1);
});
