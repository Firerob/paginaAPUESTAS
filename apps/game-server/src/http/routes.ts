import { Router, type Request, type Response } from "express";
import { formatCOP } from "@ah/shared";
import { getBalance } from "../services/wallet.service";
import { pool } from "../db/pool";
import { env } from "../config/env";
import { requireAuth } from "./auth.middleware";
import { authRoutes } from "./auth.routes";
import { cashierRoutes } from "./cashier.routes";
import { activityRoutes } from "./activity.routes";

export const routes = Router();

/** Health check para el balanceador. No toca la base en el camino caliente. */
routes.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, version: env.serverVersion });
});

/** Health profundo: verifica que la base responde. */
routes.get("/health/deep", async (_req: Request, res: Response) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, db: "up" });
  } catch {
    res.status(503).json({ ok: false, db: "down" });
  }
});

/** Saldo del usuario autenticado. */
routes.get("/api/me/balance", async (req: Request, res: Response) => {
  const userId = await requireAuth(req, res);
  if (!userId) return;

  try {
    const balance = await getBalance(userId);
    res.json({
      available: balance.available,
      locked: balance.locked,
      withdrawable: balance.withdrawable,
      bonus: balance.bonus,
      formatted: formatCOP(balance.available),
      currency: "COP",
    });
  } catch {
    res.status(404).json({ error: "wallet_missing" });
  }
});

routes.use(authRoutes);
routes.use(cashierRoutes);
routes.use(activityRoutes);

/** Historial de partidas. Lo que el jugador puede auditar de lo suyo. */
routes.get("/api/me/matches", async (req: Request, res: Response) => {
  const userId = await requireAuth(req, res);
  if (!userId) return;

  const { rows } = await pool.query(
    `SELECT m.id, m.stake, m.status, m.end_reason, m.score_home, m.score_away,
            m.pot, m.rake, m.payout, m.winner_user_id, m.created_at, m.ended_at,
            mp.seat, mp.result
       FROM match_players mp
       JOIN matches m ON m.id = mp.match_id
      WHERE mp.user_id = $1
      ORDER BY m.created_at DESC
      LIMIT 50`,
    [userId],
  );
  res.json({ matches: rows });
});

/** Movimientos de saldo del usuario. El extracto contable. */
routes.get("/api/me/ledger", async (req: Request, res: Response) => {
  const userId = await requireAuth(req, res);
  if (!userId) return;

  const { rows } = await pool.query(
    `SELECT id, match_id, kind, amount, locked_delta, balance_after, created_at
       FROM ledger_entries
      WHERE user_id = $1
      ORDER BY id DESC
      LIMIT 100`,
    [userId],
  );
  res.json({ entries: rows });
});
