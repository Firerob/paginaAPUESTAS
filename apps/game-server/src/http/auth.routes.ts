import { Router, type Request, type Response } from "express";
import { issueToken } from "../auth/jwt";

const DEV_USERS: Record<string, { id: string; name: string }> = {
  ana: { id: "00000000-0000-0000-0000-000000000001", name: "Ana" },
  beto: { id: "00000000-0000-0000-0000-000000000002", name: "Beto" },
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
authRoutes.post("/api/auth/dev-login", (req: Request, res: Response) => {
  const body = req.body as { user?: string };
  const user = DEV_USERS[body.user ?? "ana"];
  if (!user) {
    res.status(400).json({ error: "usuario de prueba desconocido" });
    return;
  }

  const token = issueToken(user.id, user.name);
  res.json({ token, userId: user.id, displayName: user.name });
});
