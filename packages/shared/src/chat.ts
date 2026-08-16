/**
 * Contrato del chat global. Vive en un namespace de Socket.io propio
 * (`/chat`), separado del namespace de partidas: ahi la conexion exige JWT
 * valido siempre (es dinero), aca cualquiera puede entrar a MIRAR sin
 * cuenta. Lo unico que el JWT protege en este canal es quien puede ESCRIBIR.
 */

/** Eventos que el cliente puede emitir en el namespace de chat. */
export const ChatClientMessage = {
  /** Unico mensaje que puede mandar un visitante sin sesion: ninguno.
   *  Enviar texto requiere JWT valido en el handshake — ver ChatServerMessage.REJECTED. */
  SEND_MESSAGE: "chat:send_message",
} as const;

/** Eventos que emite el servidor en el namespace de chat. */
export const ChatServerMessage = {
  /** Los ultimos N mensajes reales, en orden cronologico. Llega una sola vez, al conectar. */
  HISTORY: "chat:history",
  /** Un mensaje nuevo, a todo el que este en la sala. */
  MESSAGE_RECEIVED: "chat:message_received",
  /** El servidor descarto el mensaje (sin sesion, muy largo, muy seguido). */
  REJECTED: "chat:rejected",
} as const;

/** Unica sala del chat global. Namespace + sala separados por si el dia de
 *  mañana hace falta una sala por juego: el nombre ya no es un supuesto implicito. */
export const CHAT_ROOM = "global_chat";

/** Limite de caracteres por mensaje. El servidor SIEMPRE lo re-valida: el
 *  `maxLength` del input es cortesia de UX, no la garantia real. */
export const CHAT_MAX_LEN = 120;

export interface ChatMessagePayload {
  id: string;
  userId: string;
  name: string;
  text: string;
  /** epoch ms, siempre reloj del servidor — nunca el del cliente. */
  at: number;
}

export interface ChatRejectedPayload {
  reason: "not_authenticated" | "empty" | "too_long" | "rate_limited";
}
