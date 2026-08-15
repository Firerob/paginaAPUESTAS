import type { Request, Response } from "express";
import { AuthError, verifyToken } from "../auth/jwt";

/** Extrae y valida el Bearer token. Responde 401 y devuelve null si falla. */
export async function requireAuth(req: Request, res: Response): Promise<string | null> {
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  try {
    const user = await verifyToken(token);
    return user.userId;
  } catch (error) {
    const code = error instanceof AuthError ? error.code : "invalid_token";
    res.status(401).json({ error: code });
    return null;
  }
}
