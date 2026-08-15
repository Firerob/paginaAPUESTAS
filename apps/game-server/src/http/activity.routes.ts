import { Router, type Request, type Response } from "express";
import { pool } from "../db/pool";
import { env } from "../config/env";
import { STAKE_TIERS } from "../rooms/MatchManager";
import { connectedCount } from "../services/presence";
import { queuedByStake } from "../services/queue-stats";

/**
 * Actividad del lobby: metricas de ambiente y ganadores recientes.
 *
 * Sin autenticacion a proposito. No exponen dinero de nadie en particular
 * mas alla de lo que ya es publico dentro del propio juego (nombre visible
 * del rival, monto del pozo de una partida ya liquidada): es la misma
 * informacion que ya se le muestra a cualquiera que juegue una partida.
 */
export const activityRoutes = Router();

activityRoutes.get("/api/activity/stats", async (_req: Request, res: Response) => {
  const [{ rows: potRows }, { rows: activeRows }, { rows: byGameRows }, { rows: byStakeRows }] =
    await Promise.all([
      pool.query<{ pot: number }>(
        `SELECT COALESCE(SUM(payout), 0)::bigint AS pot
           FROM matches
          WHERE status = 'finished' AND settled_at >= date_trunc('day', now())`,
      ),
      pool.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM matches WHERE status IN ('escrowed', 'in_progress')`,
      ),
      // Desglose por juego: cuantas partidas activas hay ahora y cuantas se
      // liquidaron hoy. Sirve para los badges honestos de las tarjetas de
      // juego ("~N en partida", "en tendencia") en vez de inventar numeros.
      pool.query<{ game_type: "air_hockey" | "mines"; active: number; wins_today: number }>(
        `SELECT game_type,
                COUNT(*) FILTER (WHERE status IN ('escrowed', 'in_progress'))::int AS active,
                COUNT(*) FILTER (
                  WHERE status = 'finished' AND settled_at >= date_trunc('day', now())
                )::int AS wins_today
           FROM matches
          GROUP BY game_type`,
      ),
      // Jugadores YA emparejados (partida en curso) por monto de apuesta.
      // Se le suma la cola en vivo (queuedByStake, en memoria del propio
      // proceso) para el numero que ve el lobby debajo de cada ficha.
      pool.query<{ stake: number; players_in_match: number }>(
        `SELECT stake, (COUNT(*) FILTER (WHERE status IN ('escrowed', 'in_progress')) * 2)::int AS players_in_match
           FROM matches
          WHERE stake = ANY($1::bigint[])
          GROUP BY stake`,
        [STAKE_TIERS],
      ),
    ]);

  const byGame: Record<string, { active: number; winsToday: number }> = {
    air_hockey: { active: 0, winsToday: 0 },
    mines: { active: 0, winsToday: 0 },
  };
  for (const row of byGameRows) {
    byGame[row.game_type] = { active: row.active, winsToday: row.wins_today };
  }

  const queued = queuedByStake();
  const byStake: Record<number, number> = {};
  for (const tier of STAKE_TIERS) byStake[tier] = queued[tier] ?? 0;
  for (const row of byStakeRows) {
    byStake[row.stake] = (byStake[row.stake] ?? 0) + row.players_in_match;
  }

  res.json({
    online: connectedCount(),
    potToday: potRows[0].pot,
    activeMatches: activeRows[0].n,
    rakeBps: env.rakeBps,
    byGame,
    byStake,
  });
});

activityRoutes.get("/api/activity/recent-wins", async (req: Request, res: Response) => {
  const limit = Math.min(Number.parseInt(String(req.query.limit ?? "15"), 10) || 15, 50);

  const { rows } = await pool.query<{
    display_name: string;
    payout: number;
    game_type: "air_hockey" | "mines";
    settled_at: Date;
  }>(
    `SELECT u.display_name, m.payout, m.game_type, m.settled_at
       FROM matches m
       JOIN users u ON u.id = m.winner_user_id
      WHERE m.status = 'finished' AND m.winner_user_id IS NOT NULL
      ORDER BY m.settled_at DESC
      LIMIT $1`,
    [limit],
  );

  res.json({
    wins: rows.map((row) => ({
      name: row.display_name,
      payout: row.payout,
      game: row.game_type,
      at: row.settled_at,
    })),
  });
});
