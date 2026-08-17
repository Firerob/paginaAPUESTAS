import { Router, type Request, type Response } from "express";
import { issueToken } from "../auth/jwt";
import { AuthServiceError, loginUser, registerUser } from "../services/auth.service";
import { ensureDevUser } from "../services/wallet.service";

const DEV_USERS: Record<string, { id: string; name: string; email: string }> = {
  ana: { id: "00000000-0000-0000-0000-000000000001", name: "Ana", email: "ana@test.local" },
  beto: { id: "00000000-0000-0000-0000-000000000002", name: "Beto", email: "beto@test.local" },
};

export const authRoutes = Router();

/**
 * Emisor de tokens de demo. Vive aca (no como API route de Next.js) porque
 * un export estatico (GitHub Pages) no puede correr codigo de servidor: el
 * game-server es el unico proceso real que queda para emitirlos.
 *
 * A diferencia del equivalente que tenia Next.js, este NO se apaga en
 * produccion: sin un sistema de registro real todavia, es la unica forma de
 * entrar a la demo publica. Ana y Beto manejan saldo ficticio (ver
 * `002_seed_dev.sql`) — dejarlo abierto es una decision consciente para una
 * demo, no lo que haria un lanzamiento real con dinero de usuarios de
 * verdad.
 */
authRoutes.post("/api/auth/dev-login", async (req: Request, res: Response) => {
  const body = req.body as { user?: string };
  const user = DEV_USERS[body.user ?? "ana"];
  if (!user) {
    res.status(400).json({ error: "usuario de prueba desconocido" });
    return;
  }

  // Se asegura de que el usuario y su wallet existan antes de emitir el
  // token. Si la base no responde (arranque en frio, blip de red en un
  // Postgres administrado), no bloqueamos el login: el cliente igual entra
  // al lobby con un token valido, y la wallet se sanara en el proximo
  // intento que si llegue a la base.
  try {
    await ensureDevUser(user);
  } catch (error) {
    console.error("[auth] no se pudo asegurar el usuario de prueba en la base", error);
  }

  const token = issueToken(user.id, user.name);
  res.json({ token, userId: user.id, displayName: user.name });
});

// ---------------------------------------------------------------------------
// Cuentas reales: registro e inicio de sesion con contrasena
// ---------------------------------------------------------------------------

/**
 * Cubeta de intentos por clave (IP + identificador). No es una defensa
 * elaborada, solo frena fuerza bruta basica contra login/registro — mismo
 * espiritu que `consumeBudget` en AirHockeyRoom y `consumeAction` en
 * BlackjackRoom, adaptado a HTTP (sin socket que mantenga estado por si).
 */
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 5 * 60_000;
const attempts = new Map<string, { count: number; windowStart: number }>();

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    attempts.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= MAX_ATTEMPTS) return false;
  entry.count++;
  return true;
}

authRoutes.post("/api/auth/register", async (req: Request, res: Response) => {
  const body = req.body as { username?: unknown; email?: unknown; password?: unknown };
  const username = typeof body.username === "string" ? body.username : "";
  const email = typeof body.email === "string" ? body.email : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!checkRateLimit(`register:${req.ip}`)) {
    res.status(429).json({ error: "Demasiados intentos. Espera unos minutos." });
    return;
  }

  try {
    const user = await registerUser({ username, email, password });
    const token = issueToken(user.userId, user.displayName);
    res.status(201).json({ token, userId: user.userId, displayName: user.displayName });
  } catch (error) {
    if (error instanceof AuthServiceError) {
      if (error.code === "email_taken") {
        res.status(409).json({ error: "Este correo ya está registrado. Por favor, inicia sesión." });
        return;
      }
      if (error.code === "username_taken") {
        res.status(409).json({ error: "El nombre de usuario ya está en uso." });
        return;
      }
      res.status(400).json({ error: error.message });
      return;
    }
    console.error("[auth] fallo el registro", error);
    res.status(500).json({ error: "No se pudo completar el registro." });
  }
});

authRoutes.post("/api/auth/login", async (req: Request, res: Response) => {
  const body = req.body as { identifier?: unknown; password?: unknown };
  const identifier = typeof body.identifier === "string" ? body.identifier : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!checkRateLimit(`login:${req.ip}:${identifier.toLowerCase()}`)) {
    res.status(429).json({ error: "Demasiados intentos. Espera unos minutos." });
    return;
  }

  try {
    const user = await loginUser({ identifier, password });
    const token = issueToken(user.userId, user.displayName);
    res.json({ token, userId: user.userId, displayName: user.displayName });
  } catch (error) {
    if (error instanceof AuthServiceError) {
      if (error.code === "account_disabled") {
        res.status(403).json({ error: "Tu cuenta no puede iniciar sesión en este momento." });
        return;
      }
      // invalid_credentials (y cualquier otro caso de validacion): mismo
      // mensaje generico siempre, a proposito (ver auth.service.ts).
      res.status(401).json({ error: "Credenciales inválidas." });
      return;
    }
    console.error("[auth] fallo el login", error);
    res.status(500).json({ error: "No se pudo iniciar sesión." });
  }
});
