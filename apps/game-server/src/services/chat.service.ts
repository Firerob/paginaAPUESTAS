import { CHAT_MAX_LEN, type ChatMessagePayload } from "@ah/shared";
import { pool } from "../db/pool";

export class ChatError extends Error {
  constructor(readonly code: "empty" | "too_long") {
    super(code);
    this.name = "ChatError";
  }
}

/** Recorta espacios y valida el largo. Nunca confia en el limite del cliente. */
export function sanitizeChatBody(raw: string): string {
  const body = raw.trim();
  if (body.length === 0) throw new ChatError("empty");
  if (body.length > CHAT_MAX_LEN) throw new ChatError("too_long");
  return body;
}

export async function saveChatMessage(userId: string, body: string): Promise<ChatMessagePayload> {
  const { rows } = await pool.query<{
    id: string;
    body: string;
    created_at: Date;
    display_name: string;
  }>(
    `INSERT INTO chat_messages (user_id, body)
     VALUES ($1, $2)
     RETURNING id, body, created_at,
       (SELECT display_name FROM users WHERE id = $1) AS display_name`,
    [userId, body],
  );
  const row = rows[0];
  return {
    id: row.id,
    userId,
    name: row.display_name,
    text: row.body,
    at: row.created_at.getTime(),
  };
}

/** Los ultimos `limit` mensajes reales, en orden CRONOLOGICO (mas viejo primero). */
export async function recentChatMessages(limit = 50): Promise<ChatMessagePayload[]> {
  const { rows } = await pool.query<{
    id: string;
    user_id: string;
    body: string;
    created_at: Date;
    display_name: string;
  }>(
    `SELECT cm.id, cm.user_id, cm.body, cm.created_at, u.display_name
       FROM chat_messages cm
       JOIN users u ON u.id = cm.user_id
      ORDER BY cm.created_at DESC, cm.id DESC
      LIMIT $1`,
    [limit],
  );
  return rows
    .map((row) => ({
      id: row.id,
      userId: row.user_id,
      name: row.display_name,
      text: row.body,
      at: row.created_at.getTime(),
    }))
    .reverse();
}
