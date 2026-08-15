import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { pool } from "../db/pool";

/**
 * Identidad autenticada. Es lo unico que el servidor cree del cliente respecto
 * de quien es. Nunca se lee el userId de un mensaje del socket.
 */
export interface AuthedUser {
  userId: string;
  displayName: string;
  /** jti del token, para poder revocar una sesion concreta. */
  sessionId: string;
}

interface TokenClaims {
  sub: string;
  name: string;
  jti: string;
  iss: string;
  aud: string;
  exp: number;
  iat: number;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly code:
      | "missing_token"
      | "invalid_token"
      | "expired_token"
      | "user_not_found"
      | "user_blocked",
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/** Emite un token de sesion. En produccion esto vive en el servicio de auth. */
export function issueToken(userId: string, displayName: string, ttlSeconds = 3600): string {
  return jwt.sign({ name: displayName }, env.jwtSecret, {
    subject: userId,
    issuer: env.jwtIssuer,
    audience: env.jwtAudience,
    expiresIn: ttlSeconds,
    jwtid: `${userId}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    algorithm: "HS256",
  });
}

/**
 * Verifica el token y confirma contra la base que el usuario sigue habilitado.
 *
 * Los dos pasos importan: la firma prueba que el token lo emitimos nosotros,
 * y la consulta prueba que la cuenta no fue suspendida ni auto-excluida
 * despues de emitirlo. Un token valido de un usuario bloqueado no entra.
 */
export async function verifyToken(token: unknown): Promise<AuthedUser> {
  if (typeof token !== "string" || token.length === 0) {
    throw new AuthError("token ausente", "missing_token");
  }

  let claims: TokenClaims;
  try {
    claims = jwt.verify(token, env.jwtSecret, {
      issuer: env.jwtIssuer,
      audience: env.jwtAudience,
      algorithms: ["HS256"], // fija el algoritmo: bloquea el ataque alg=none
    }) as TokenClaims;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new AuthError("token expirado", "expired_token");
    }
    throw new AuthError("token invalido", "invalid_token");
  }

  const { rows } = await pool.query<{ id: string; display_name: string; status: string }>(
    "SELECT id, display_name, status FROM users WHERE id = $1 AND role = 'player'",
    [claims.sub],
  );

  const user = rows[0];
  if (!user) {
    throw new AuthError("usuario inexistente", "user_not_found");
  }
  if (user.status !== "active") {
    throw new AuthError(`cuenta en estado ${user.status}`, "user_blocked");
  }

  return {
    userId: user.id,
    displayName: user.display_name,
    sessionId: claims.jti,
  };
}
