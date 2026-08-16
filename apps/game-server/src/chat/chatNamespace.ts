import type { Namespace, Server as IOServer, Socket } from "socket.io";
import {
  CHAT_ROOM,
  ChatClientMessage,
  ChatServerMessage,
  type ChatRejectedPayload,
} from "@ah/shared";
import { verifyToken } from "../auth/jwt";
import { ChatError, recentChatMessages, sanitizeChatBody, saveChatMessage } from "../services/chat.service";

/** Minimo tiempo entre dos mensajes del mismo socket. No es un captcha, solo evita flood. */
const SEND_COOLDOWN_MS = 1200;

/** `WeakMap`, no `Map`: el registro se libera solo cuando el socket se recolecta, sin
 *  necesitar un handler de `disconnect` que lo limpie a mano. */
const lastSentAt = new WeakMap<Socket, number>();

/**
 * Namespace de chat, separado del namespace de partidas (la raiz `/`).
 *
 * La diferencia con el namespace de partidas no es de implementacion, es de
 * postura: ahi CADA conexion mueve o puede mover dinero, asi que un token
 * invalido corta la conexion en el acto. Aca la lectura es publica a
 * proposito (cualquiera puede mirar el canal sin cuenta) — lo unico que
 * exige sesion es escribir, y eso se re-valida en cada `chat:send_message`,
 * nunca confiando en que el handshake haya traido token la primera vez.
 */
export function registerChatNamespace(io: IOServer): void {
  const chat = io.of("/chat");

  chat.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (typeof token === "string" && token.length > 0) {
      try {
        const user = await verifyToken(token);
        socket.data.userId = user.userId;
        socket.data.displayName = user.displayName;
      } catch {
        // Token ausente o invalido: entra igual, como visitante de solo
        // lectura. A diferencia del namespace de partidas, esto no es un
        // error de conexion.
      }
    }
    next();
  });

  chat.on("connection", (socket) => {
    void socket.join(CHAT_ROOM);

    void recentChatMessages(50)
      .then((history) => socket.emit(ChatServerMessage.HISTORY, history))
      .catch((error) => console.error("[chat] no se pudo cargar el historial", error));

    socket.on(ChatClientMessage.SEND_MESSAGE, (raw: unknown) => {
      void handleSend(chat, socket, raw);
    });
  });
}

async function handleSend(chat: Namespace, socket: Socket, raw: unknown): Promise<void> {
  const userId = socket.data.userId as string | undefined;
  if (!userId) {
    reject(socket, "not_authenticated");
    return;
  }

  const now = Date.now();
  const last = lastSentAt.get(socket) ?? 0;
  if (now - last < SEND_COOLDOWN_MS) {
    reject(socket, "rate_limited");
    return;
  }

  let body: string;
  try {
    body = sanitizeChatBody(typeof raw === "string" ? raw : "");
  } catch (error) {
    reject(socket, error instanceof ChatError ? error.code : "empty");
    return;
  }

  lastSentAt.set(socket, now);

  try {
    const message = await saveChatMessage(userId, body);
    chat.to(CHAT_ROOM).emit(ChatServerMessage.MESSAGE_RECEIVED, message);
  } catch (error) {
    console.error("[chat] no se pudo guardar el mensaje", error);
  }
}

function reject(socket: Socket, reason: ChatRejectedPayload["reason"]): void {
  socket.emit(ChatServerMessage.REJECTED, { reason } satisfies ChatRejectedPayload);
}
