import { Router, type Request, type Response } from "express";
import { MINES_SIZES, STAKE_TIERS, type GameType } from "@ah/shared";
import { pool } from "../db/pool";
import { env } from "../config/env";
import { connectedCount } from "../services/presence";
import { getQueueSnapshot } from "../services/queue-stats";

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
  const [
    { rows: potRows },
    { rows: activeRows },
    { rows: byGameRows },
    { rows: byGameStakeRows },
    { rows: minesBoardRows },
  ] = await Promise.all([
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
    pool.query<{ game_type: GameType; active: number; wins_today: number }>(
      `SELECT game_type,
              COUNT(*) FILTER (WHERE status IN ('escrowed', 'in_progress'))::int AS active,
              COUNT(*) FILTER (
                WHERE status = 'finished' AND settled_at >= date_trunc('day', now())
              )::int AS wins_today
         FROM matches
        GROUP BY game_type`,
    ),
    // Jugadores YA emparejados (partida en curso), por JUEGO y apuesta. Air
    // Hockey y Minas nunca se suman entre si: son colas y salas separadas.
    pool.query<{ game_type: GameType; stake: number; players_in_match: number }>(
      `SELECT game_type, stake,
              (COUNT(*) FILTER (WHERE status IN ('escrowed', 'in_progress')) * 2)::int AS players_in_match
         FROM matches
        WHERE stake = ANY($1::bigint[])
        GROUP BY game_type, stake`,
      [STAKE_TIERS],
    ),
    // Lo mismo pero solo Minas, desglosado ademas por tamaño de tablero
    // (`config->>'size'`, escrito por MinesRoom.gameConfig() al crear la
    // partida — ya esta ahi para cuando el estado pasa a 'escrowed').
    pool.query<{ size: number; stake: number; players_in_match: number }>(
      `SELECT (config->>'size')::int AS size, stake,
              (COUNT(*) FILTER (WHERE status IN ('escrowed', 'in_progress')) * 2)::int AS players_in_match
         FROM matches
        WHERE game_type = 'mines' AND stake = ANY($1::bigint[])
        GROUP BY config->>'size', stake`,
      [STAKE_TIERS],
    ),
  ]);

  const byGame: Record<string, { active: number; winsToday: number }> = {
    air_hockey: { active: 0, winsToday: 0 },
    mines: { active: 0, winsToday: 0 },
    blackjack: { active: 0, winsToday: 0 },
  };
  for (const row of byGameRows) {
    byGame[row.game_type] = { active: row.active, winsToday: row.wins_today };
  }

  const queue = getQueueSnapshot();

  const byStake: Record<GameType, Record<number, number>> = {
    air_hockey: {},
    mines: {},
    blackjack: {},
  };
  for (const game of ["air_hockey", "mines", "blackjack"] as GameType[]) {
    for (const tier of STAKE_TIERS) byStake[game][tier] = queue.byGameStake[game][tier] ?? 0;
  }
  for (const row of byGameStakeRows) {
    byStake[row.game_type][row.stake] = (byStake[row.game_type][row.stake] ?? 0) + row.players_in_match;
  }

  // Se pre-siembra cada tablero x apuesta en 0, igual que `byStake` con los
  // STAKE_TIERS: sin esto, un tablero sin nadie jugando faltaba del todo en
  // la respuesta y el frontend no podia distinguir "cero" de "sin cargar".
  const minesByBoard: Record<number, number> = {};
  const minesByBoardStake: Record<number, Record<number, number>> = {};
  for (const boardSize of MINES_SIZES) {
    minesByBoard[boardSize] = queue.minesBySize[boardSize] ?? 0;
    minesByBoardStake[boardSize] = {};
    for (const tier of STAKE_TIERS) {
      minesByBoardStake[boardSize][tier] = queue.minesBySizeStake[boardSize]?.[tier] ?? 0;
    }
  }
  for (const row of minesBoardRows) {
    if (row.size === null) continue; // partidas viejas sin config.size (no deberia pasar, pero no revienta)
    minesByBoard[row.size] = (minesByBoard[row.size] ?? 0) + row.players_in_match;
    const perSize = (minesByBoardStake[row.size] ??= {});
    perSize[row.stake] = (perSize[row.stake] ?? 0) + row.players_in_match;
  }

  res.json({
    online: connectedCount(),
    potToday: potRows[0].pot,
    activeMatches: activeRows[0].n,
    rakeBps: env.rakeBps,
    byGame,
    byStake,
    minesByBoard,
    minesByBoardStake,
  });
});

activityRoutes.get("/api/activity/recent-wins", async (req: Request, res: Response) => {
  const limit = Math.min(Number.parseInt(String(req.query.limit ?? "15"), 10) || 15, 50);

  const { rows } = await pool.query<{
    display_name: string;
    payout: number;
    game_type: GameType;
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
