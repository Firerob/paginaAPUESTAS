import * as crypto from "node:crypto";
import { env } from "../config/env";
import { pool } from "../db/pool";

/**
 * Ciclo de vida de la fila `matches`. El dinero lo mueve wallet.service; aqui
 * solo se administra el registro de la partida y su bitacora.
 */

export interface MatchRecord {
  id: string;
  roomId: string;
  stake: number;
  rakeBps: number;
  seed: string;
}

export interface CreateMatchOptions {
  gameType?: string;
  /** Parametros del juego, se guardan tal cual para auditoria. */
  config?: Record<string, unknown>;
  /**
   * Compromiso del estado inicial (SHA-256 de la semilla).
   *
   * Se guarda ANTES de la primera jugada. Es lo que permite demostrar
   * despues que el tablero no cambio a mitad de partida.
   */
  commitHash?: string | null;
  /** Semilla ya generada por el juego. Si no viene, se genera aqui. */
  seed?: string;
}

/** Crea la partida en estado 'matchmaking'. Aun no hay dinero comprometido. */
export async function createMatch(
  roomId: string,
  stake = env.stakeCop,
  options: CreateMatchOptions = {},
): Promise<MatchRecord> {
  const seed = options.seed ?? crypto.randomBytes(16).toString("hex");
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO matches
       (room_id, stake, rake_bps, seed, server_version, heartbeat_at,
        game_type, config, commit_hash)
     VALUES ($1, $2, $3, $4, $5, now(), $6, $7::jsonb, $8)
     RETURNING id`,
    [
      roomId,
      stake,
      env.rakeBps,
      seed,
      env.serverVersion,
      options.gameType ?? "air_hockey",
      JSON.stringify(options.config ?? {}),
      options.commitHash ?? null,
    ],
  );
  return { id: rows[0].id, roomId, stake, rakeBps: env.rakeBps, seed };
}

/**
 * Publica la semilla al terminar la partida.
 *
 * Se hace en un paso aparte y despues del final a proposito: revelarla antes
 * le entregaria el tablero al jugador. `revealed_at` deja constancia de
 * cuando ocurrio, para poder auditar que no se adelanto.
 */
export async function revealSeed(matchId: string): Promise<void> {
  await pool.query(
    "UPDATE matches SET revealed_at = now() WHERE id = $1 AND revealed_at IS NULL",
    [matchId],
  );
}

export async function markInProgress(matchId: string): Promise<void> {
  await pool.query(
    `UPDATE matches
        SET status = 'in_progress', started_at = COALESCE(started_at, now()), heartbeat_at = now()
      WHERE id = $1 AND status = 'escrowed'`,
    [matchId],
  );
}

export async function updateScore(
  matchId: string,
  scoreHome: number,
  scoreAway: number,
): Promise<void> {
  await pool.query(
    "UPDATE matches SET score_home = $2, score_away = $3, heartbeat_at = now() WHERE id = $1",
    [matchId, scoreHome, scoreAway],
  );
}

/**
 * Latido periodico. Si el proceso muere, `heartbeat_at` deja de avanzar y el
 * sweeper puede distinguir una partida viva de una huerfana con dinero preso.
 */
export async function heartbeat(matchId: string): Promise<void> {
  await pool.query("UPDATE matches SET heartbeat_at = now() WHERE id = $1", [matchId]);
}

export async function countDisconnect(matchId: string, userId: string): Promise<void> {
  await pool.query(
    "UPDATE match_players SET disconnects = disconnects + 1 WHERE match_id = $1 AND user_id = $2",
    [matchId, userId],
  );
}

/**
 * Bitacora. Se usa para resolver disputas ("me robaron el gol") y para
 * alimentar la deteccion de patrones raros de input.
 *
 * Nunca lanza: un fallo al escribir telemetria no debe cortar la partida.
 */
export async function recordEvent(
  matchId: string,
  type: string,
  payload: Record<string, unknown> = {},
  opts: { userId?: string; tick?: number } = {},
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO match_events (match_id, user_id, tick, type, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [matchId, opts.userId ?? null, opts.tick ?? 0, type, JSON.stringify(payload)],
    );
  } catch (error) {
    console.error("[match] no se pudo registrar el evento", type, error);
  }
}

/** Partidas con dinero bloqueado cuyo servidor dejo de latir. */
export async function findStaleMatches(olderThanSeconds: number): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM matches
      WHERE status IN ('escrowed', 'in_progress')
        AND settled_at IS NULL
        AND (heartbeat_at IS NULL OR heartbeat_at < now() - ($1 || ' seconds')::interval)`,
    [olderThanSeconds],
  );
  return rows.map((r) => r.id);
}
