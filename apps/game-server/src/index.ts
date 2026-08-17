import * as http from "node:http";
import cors from "cors";
import express from "express";
import { Server as IOServer } from "socket.io";
import { env } from "./config/env";
import { routes } from "./http/routes";
import { AuthError, verifyToken } from "./auth/jwt";
import { MatchManager } from "./rooms/MatchManager";
import { registerChatNamespace } from "./chat/chatNamespace";
import { startSweeper, stopSweeper } from "./services/sweeper";
import { markConnected, markDisconnected } from "./services/presence";
import { closePool, pool } from "./db/pool";
import { runMigrations } from "./db/migrate";

async function main(): Promise<void> {
  // Falla rapido si la base no esta lista: mejor no arrancar que aceptar
  // apuestas sin poder registrarlas.
  await pool.query("SELECT 1");

  // Aplica migraciones pendientes antes de aceptar trafico. Esto reemplaza el
  // paso manual post-deploy en Render: si el esquema todavia no existe (base
  // recien creada), queda listo solo con el arranque del servicio. La semilla
  // de Ana/Beto se sigue salteando aqui en produccion (ver `runMigrations`);
  // esos dos usuarios se auto-crean bajo demanda desde `/api/auth/dev-login`.
  const migrationsApplied = await runMigrations();
  if (migrationsApplied > 0) {
    console.log(`[game-server] ${migrationsApplied} migracion(es) aplicadas al arrancar`);
  }

  // Se comparte entre Express y Socket.IO abajo: los dos deben aceptar
  // exactamente los mismos origenes, o el fetch pasa pero el socket no (o
  // viceversa) y el sintoma es confuso a medias.
  //
  // El origen SIGUE siendo una lista fija (`env.corsOrigin`), no una funcion
  // que aprueba cualquier cosa: un callback que hace `callback(null, true)`
  // en el caso "no permitido" no arregla un 404 (ese es un problema de
  // enrutamiento, no de CORS) y de paso apaga el chequeo de origen — con
  // `credentials: true` eso es peor, no una red de seguridad para pruebas.
  const corsOptions: cors.CorsOptions = {
    origin: env.corsOrigin,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  };

  const app = express();
  // Render (y la mayoria de PaaS) ponen el servicio detras de un proxy: sin
  // esto, `req.ip` siempre devuelve la IP interna del proxy, no la del
  // cliente real — y el limitador de intentos de /api/auth/login|register
  // terminaria agrupando a todo el mundo bajo la misma IP.
  app.set("trust proxy", 1);
  app.use(cors(corsOptions));
  // La libreria `cors` ya responde el preflight solo con el middleware de
  // arriba; esto es un manejador explicito de refuerzo para *cualquier*
  // ruta, util si algo (un proxy, un 404 antes de tiempo) se lo llegara a
  // comer antes de que el middleware normal corra.
  app.options("*", cors(corsOptions));
  app.use(express.json({ limit: "16kb" }));
  app.use(routes);

  const httpServer = http.createServer(app);

  const io = new IOServer(httpServer, {
    cors: corsOptions,
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
  registerChatNamespace(io);

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
