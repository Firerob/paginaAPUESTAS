import { Router, type Request, type Response } from "express";
import { issueToken } from "../auth/jwt";
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
