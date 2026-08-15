import * as http from "node:http";
import cors from "cors";
import express from "express";
import { Server as IOServer } from "socket.io";
import { env } from "./config/env";
import { routes } from "./http/routes";
import { AuthError, verifyToken } from "./auth/jwt";
import { MatchManager } from "./rooms/MatchManager";
import { startSweeper, stopSweeper } from "./services/sweeper";
import { markConnected, markDisconnected } from "./services/presence";
import { closePool, pool } from "./db/pool";

async function main(): Promise<void> {
  // Falla rapido si la base no esta lista: mejor no arrancar que aceptar
  // apuestas sin poder registrarlas.
  await pool.query("SELECT 1");

  const app = express();
  app.use(cors({ origin: env.corsOrigin, credentials: true }));
  app.use(express.json({ limit: "16kb" }));
  app.use(routes);

  const httpServer = http.createServer(app);

  const io = new IOServer(httpServer, {
    cors: { origin: env.corsOrigin, credentials: true },
    // El unico mensaje legitimo del cliente es {x, y}: cualquier payload
    // grande es basura o un intento de agotar memoria.
    maxHttpBufferSize: 1024,
    pingInterval: 5000,
    pingTimeout: 8000,
    // Solo WebSocket: el long-polling multiplica la latencia y no aporta nada
    // en un juego de accion.
    transports: ["websocket"],
  });

  /**
   * Autenticacion del socket, ANTES de que exista la conexion.
   *
   * El userId sale del `sub` del JWT verificado y se guarda en socket.data.
   * Ningun handler lee jamas la identidad de un mensaje del cliente.
   */
  io.use(async (socket, next) => {
    try {
      const user = await verifyToken(socket.handshake.auth?.token);
      socket.data.userId = user.userId;
      socket.data.displayName = user.displayName;
      next();
    } catch (error) {
      const code = error instanceof AuthError ? error.code : "auth_failed";
      next(new Error(code));
    }
  });

  const matchmaking = new MatchManager(io);

  io.on("connection", (socket) => {
    markConnected();
    socket.once("disconnect", markDisconnected);

    void matchmaking.handleConnection(socket).catch((error) => {
      console.error("[io] fallo al procesar la conexion", error);
      socket.disconnect(true);
    });
  });

  startSweeper();

  await new Promise<void>((resolve) => httpServer.listen(env.port, resolve));
  console.log(`[game-server] escuchando en :${env.port} (${env.nodeEnv})`);
  console.log(`[game-server] apuesta por defecto ${env.stakeCop} COP, rake ${env.rakeBps / 100}%`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[game-server] ${signal} recibido, cerrando...`);
    stopSweeper();
    // Devuelve el dinero de las partidas en curso antes de morir. El sweeper
    // cubre el caso en que ni esto alcance a correr (SIGKILL, corte de luz).
    await matchmaking.shutdown();
    io.close();
    httpServer.close();
    await closePool();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("[game-server] no se pudo arrancar", error);
  process.exit(1);
});
