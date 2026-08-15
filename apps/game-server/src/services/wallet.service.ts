import type { PoolClient } from "pg";
import { computeSettlement, type EndReason } from "@ah/shared";
import { env } from "../config/env";
import { pool, withTransaction } from "../db/pool";

/**
 * Servicio de saldo. Es el unico modulo autorizado a mover dinero.
 *
 * Reglas que se respetan en todas las funciones de aqui:
 *
 *  1. Una sola transaccion por operacion. No hay estados intermedios visibles:
 *     el escrow bloquea a los dos jugadores o no bloquea a ninguno.
 *  2. `SELECT ... FOR UPDATE` sobre las wallets, SIEMPRE ordenadas por user_id.
 *     El orden fijo es lo que evita el deadlock cuando dos partidas tocan a los
 *     mismos usuarios al mismo tiempo.
 *  3. Cada movimiento escribe una fila en `ledger_entries` con una
 *     `idempotency_key` deterministica. Si el servidor reintenta, la clave
 *     UNIQUE hace fallar el INSERT y la transaccion entera se revierte:
 *     imposible pagar dos veces.
 *  4. Las guardas de no-negatividad viven en el CHECK de la tabla. Si un bug
 *     de logica intentara dejar un saldo negativo, Postgres aborta.
 */

export class WalletError extends Error {
  constructor(
    message: string,
    readonly code:
      | "insufficient_funds"
      | "wallet_missing"
      | "already_in_match"
      | "match_not_found"
      | "already_settled",
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "WalletError";
  }
}

export interface WalletBalance {
  available: number;
  locked: number;
  withdrawable: number;
  bonus: number;
}

interface WalletRow {
  user_id: string;
  available: number;
  locked: number;
  withdrawable: number;
  bonus: number;
}

/** Bloquea (FOR UPDATE) las wallets indicadas en orden estable. */
async function lockWallets(client: PoolClient, userIds: string[]): Promise<Map<string, WalletRow>> {
  const ordered = [...new Set(userIds)].sort();
  const { rows } = await client.query<WalletRow>(
    `SELECT user_id, available, locked, withdrawable, bonus
       FROM wallets
      WHERE user_id = ANY($1::uuid[])
      ORDER BY user_id
        FOR UPDATE`,
    [ordered],
  );
  if (rows.length !== ordered.length) {
    const found = new Set(rows.map((r) => r.user_id));
    const missing = ordered.filter((id) => !found.has(id));
    throw new WalletError("wallet inexistente", "wallet_missing", { missing });
  }
  return new Map(rows.map((r) => [r.user_id, r]));
}

/**
 * Aplica un movimiento a una wallet ya bloqueada y lo asienta en el diario.
 *
 * `withdrawableDelta` por defecto es igual a `amount`: mientras `bonus` se
 * mantenga en 0 (no hay todavia motor de promociones), todo movimiento de
 * dinero real debe mover `withdrawable` exactamente igual que `available`
 * para sostener el invariante `withdrawable <= available`. El dia que exista
 * saldo de bono, las llamadas que lo toquen pasaran un `withdrawableDelta`
 * distinto de `amount` explicitamente.
 */
export async function applyEntry(
  client: PoolClient,
  params: {
    userId: string;
    matchId: string | null;
    kind: string;
    /** Efecto sobre `available`, con signo. */
    amount: number;
    /** Efecto sobre `locked`, con signo. */
    lockedDelta: number;
    /** Efecto sobre `withdrawable`, con signo. Por defecto, igual a `amount`. */
    withdrawableDelta?: number;
    idempotencyKey: string;
    metadata?: Record<string, unknown>;
  },
): Promise<{ available: number; locked: number; withdrawable: number; bonus: number }> {
  const withdrawableDelta = params.withdrawableDelta ?? params.amount;

  const { rows } = await client.query<{
    available: number;
    locked: number;
    withdrawable: number;
    bonus: number;
  }>(
    `UPDATE wallets
        SET available    = available + $2,
            locked        = locked + $3,
            withdrawable  = withdrawable + $4,
            version       = version + 1
      WHERE user_id = $1
      RETURNING available, locked, withdrawable, bonus`,
    [params.userId, params.amount, params.lockedDelta, withdrawableDelta],
  );

  const wallet = rows[0];
  if (!wallet) {
    throw new WalletError("wallet inexistente", "wallet_missing", { userId: params.userId });
  }

  await client.query(
    `INSERT INTO ledger_entries
       (user_id, match_id, kind, amount, locked_delta,
        balance_after, locked_after, withdrawable_after, idempotency_key, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
    [
      params.userId,
      params.matchId,
      params.kind,
      params.amount,
      params.lockedDelta,
      wallet.available,
      wallet.locked,
      wallet.withdrawable,
      params.idempotencyKey,
      JSON.stringify(params.metadata ?? {}),
    ],
  );

  return wallet;
}

export async function getBalance(userId: string): Promise<WalletBalance> {
  const { rows } = await pool.query<WalletRow>(
    "SELECT user_id, available, locked, withdrawable, bonus FROM wallets WHERE user_id = $1",
    [userId],
  );
  const wallet = rows[0];
  if (!wallet) throw new WalletError("wallet inexistente", "wallet_missing", { userId });
  return {
    available: wallet.available,
    locked: wallet.locked,
    withdrawable: wallet.withdrawable,
    bonus: wallet.bonus,
  };
}

/** Chequeo barato y NO vinculante, para rechazar temprano en onAuth. */
export async function hasFunds(userId: string, stake: number): Promise<boolean> {
  const { rows } = await pool.query<{ ok: boolean }>(
    "SELECT (available >= $2) AS ok FROM wallets WHERE user_id = $1",
    [userId, stake],
  );
  return rows[0]?.ok === true;
}

// ---------------------------------------------------------------------------
// ESCROW: bloqueo del saldo de los dos jugadores
// ---------------------------------------------------------------------------

export interface EscrowResult {
  matchId: string;
  stake: number;
  balances: Record<string, WalletBalance>;
}

/**
 * Bloquea la apuesta de ambos jugadores y deja la partida en estado 'escrowed'.
 *
 * Es todo-o-nada: si a cualquiera de los dos le falta saldo, la transaccion se
 * revierte completa y ninguno queda con dinero retenido. La partida no arranca.
 */
export async function escrowMatch(params: {
  matchId: string;
  stake: number;
  players: Array<{ userId: string; seat: 0 | 1 }>;
}): Promise<EscrowResult> {
  const { matchId, stake, players } = params;
  if (players.length !== 2) {
    throw new WalletError("se requieren exactamente 2 jugadores", "match_not_found");
  }

  return withTransaction(async (client) => {
    // Bloquea la partida primero: fija el orden global de locks
    // (match -> wallets) y evita carreras con la liquidacion.
    const matchRes = await client.query<{ id: string; status: string }>(
      "SELECT id, status FROM matches WHERE id = $1 FOR UPDATE",
      [matchId],
    );
    const match = matchRes.rows[0];
    if (!match) throw new WalletError("partida inexistente", "match_not_found", { matchId });
    if (match.status !== "matchmaking") {
      throw new WalletError(`partida en estado ${match.status}`, "already_settled", { matchId });
    }

    const wallets = await lockWallets(
      client,
      players.map((p) => p.userId),
    );

    // Verifica saldo de los dos ANTES de tocar nada.
    for (const player of players) {
      const wallet = wallets.get(player.userId)!;
      if (wallet.available < stake) {
        throw new WalletError("saldo insuficiente", "insufficient_funds", {
          userId: player.userId,
          available: wallet.available,
          required: stake,
        });
      }
    }

    const balances: Record<string, WalletBalance> = {};
    for (const player of players) {
      // El indice parcial match_players_one_open_per_user_idx hace fallar este
      // INSERT si el usuario ya tiene otra partida sin resolver. Esa es la
      // defensa real contra apostar el mismo saldo en dos pestañas.
      try {
        await client.query(
          `INSERT INTO match_players (match_id, user_id, seat, stake_held)
           VALUES ($1, $2, $3, $4)`,
          [matchId, player.userId, player.seat, stake],
        );
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new WalletError("el usuario ya esta en otra partida abierta", "already_in_match", {
            userId: player.userId,
          });
        }
        throw error;
      }

      balances[player.userId] = await applyEntry(client, {
        userId: player.userId,
        matchId,
        kind: "BET_HOLD",
        amount: -stake,
        lockedDelta: stake,
        idempotencyKey: `hold:${matchId}:${player.userId}`,
        metadata: { seat: player.seat },
      });
    }

    await client.query(
      `UPDATE matches
          SET status = 'escrowed', pot = $2, heartbeat_at = now()
        WHERE id = $1`,
      [matchId, stake * 2],
    );

    return { matchId, stake, balances };
  });
}

// ---------------------------------------------------------------------------
// LIQUIDACION: pago del ganador
// ---------------------------------------------------------------------------

export interface SettlementResult {
  matchId: string;
  winnerUserId: string;
  loserUserId: string;
  pot: number;
  rake: number;
  payout: number;
  balances: Record<string, WalletBalance>;
  /** true si la partida ya estaba liquidada y esta llamada no hizo nada. */
  alreadySettled: boolean;
}

/**
 * Declara ganador y liquida.
 *
 * Movimientos (apuesta 1.000 c/u, rake 10%):
 *   ganador: BET_RELEASE +1000 available / -1000 locked  (recupera lo suyo)
 *            BET_WIN      +800 available                 (gana lo del rival, neto)
 *   perdedor: BET_LOSS               -1000 locked
 *   casa:     RAKE         +200 available
 *
 * Suma de `amount` = +2000, suma de `locked_delta` = -2000. El sistema cuadra.
 *
 * Idempotente por dos vias independientes: el `FOR UPDATE` sobre la partida con
 * chequeo de `settled_at`, y las claves unicas del diario.
 */
export async function settleMatch(params: {
  matchId: string;
  winnerUserId: string;
  endReason: EndReason;
  scoreHome: number;
  scoreAway: number;
}): Promise<SettlementResult> {
  const { matchId, winnerUserId, endReason, scoreHome, scoreAway } = params;

  return withTransaction(async (client) => {
    const matchRes = await client.query<{
      id: string;
      stake: number;
      rake_bps: number;
      status: string;
      settled_at: Date | null;
      winner_user_id: string | null;
      pot: number | null;
      rake: number | null;
      payout: number | null;
    }>(
      `SELECT id, stake, rake_bps, status, settled_at, winner_user_id, pot, rake, payout
         FROM matches WHERE id = $1 FOR UPDATE`,
      [matchId],
    );
    const match = matchRes.rows[0];
    if (!match) throw new WalletError("partida inexistente", "match_not_found", { matchId });

    const playersRes = await client.query<{ user_id: string; seat: number }>(
      "SELECT user_id, seat FROM match_players WHERE match_id = $1 ORDER BY seat",
      [matchId],
    );
    const participants = playersRes.rows;

    // Ya liquidada: devolvemos el resultado guardado en vez de pagar de nuevo.
    if (match.settled_at !== null) {
      const balances: Record<string, WalletBalance> = {};
      // Se lee con el MISMO cliente de la transaccion: pedir otra conexion al
      // pool mientras se sostiene una transaccion es como se agota el pool.
      const balRes = await client.query<WalletRow>(
        "SELECT user_id, available, locked, withdrawable, bonus FROM wallets WHERE user_id = ANY($1::uuid[])",
        [participants.map((p) => p.user_id)],
      );
      for (const row of balRes.rows) {
        balances[row.user_id] = {
          available: row.available,
          locked: row.locked,
          withdrawable: row.withdrawable,
          bonus: row.bonus,
        };
      }
      const loser = participants.find((p) => p.user_id !== match.winner_user_id);
      return {
        matchId,
        winnerUserId: match.winner_user_id!,
        loserUserId: loser?.user_id ?? "",
        pot: match.pot ?? 0,
        rake: match.rake ?? 0,
        payout: match.payout ?? 0,
        balances,
        alreadySettled: true,
      };
    }

    if (match.status !== "escrowed" && match.status !== "in_progress") {
      throw new WalletError(`no se puede liquidar en estado ${match.status}`, "already_settled", {
        matchId,
      });
    }
    if (participants.length !== 2) {
      throw new WalletError("la partida no tiene 2 jugadores", "match_not_found", { matchId });
    }

    const loser = participants.find((p) => p.user_id !== winnerUserId);
    if (!loser || !participants.some((p) => p.user_id === winnerUserId)) {
      throw new WalletError("el ganador no participa en esta partida", "match_not_found", {
        matchId,
        winnerUserId,
      });
    }

    const { pot, rake, payout } = computeSettlement(match.stake, match.rake_bps);
    const netWin = payout - match.stake; // lo que gana por encima de su apuesta

    const walletIds = [winnerUserId, loser.user_id];
    if (rake > 0) walletIds.push(env.houseUserId);
    await lockWallets(client, walletIds);

    const balances: Record<string, WalletBalance> = {};

    // Ganador: recupera su apuesta y cobra el neto.
    await applyEntry(client, {
      userId: winnerUserId,
      matchId,
      kind: "BET_RELEASE",
      amount: match.stake,
      lockedDelta: -match.stake,
      idempotencyKey: `release:${matchId}:${winnerUserId}`,
      metadata: { endReason },
    });
    balances[winnerUserId] = await applyEntry(client, {
      userId: winnerUserId,
      matchId,
      kind: "BET_WIN",
      amount: netWin,
      lockedDelta: 0,
      idempotencyKey: `win:${matchId}:${winnerUserId}`,
      metadata: { endReason, pot, rake, payout },
    });

    // Perdedor: su apuesta bloqueada sale del sistema hacia el pozo.
    balances[loser.user_id] = await applyEntry(client, {
      userId: loser.user_id,
      matchId,
      kind: "BET_LOSS",
      amount: 0,
      lockedDelta: -match.stake,
      idempotencyKey: `loss:${matchId}:${loser.user_id}`,
      metadata: { endReason },
    });

    // Casa.
    if (rake > 0) {
      await applyEntry(client, {
        userId: env.houseUserId,
        matchId,
        kind: "RAKE",
        amount: rake,
        lockedDelta: 0,
        idempotencyKey: `rake:${matchId}`,
        metadata: { rakeBps: match.rake_bps, pot },
      });
    }

    await client.query(
      `UPDATE match_players SET result = 'win', goals = $3 WHERE match_id = $1 AND user_id = $2`,
      [matchId, winnerUserId, participants[0].user_id === winnerUserId ? scoreHome : scoreAway],
    );
    await client.query(
      `UPDATE match_players SET result = 'loss', goals = $3 WHERE match_id = $1 AND user_id = $2`,
      [matchId, loser.user_id, participants[0].user_id === loser.user_id ? scoreHome : scoreAway],
    );

    await client.query(
      `UPDATE matches
          SET status = 'finished', winner_user_id = $2, end_reason = $3,
              score_home = $4, score_away = $5,
              pot = $6, rake = $7, payout = $8,
              ended_at = COALESCE(ended_at, now()), settled_at = now()
        WHERE id = $1`,
      [matchId, winnerUserId, endReason, scoreHome, scoreAway, pot, rake, payout],
    );

    return {
      matchId,
      winnerUserId,
      loserUserId: loser.user_id,
      pot,
      rake,
      payout,
      balances,
      alreadySettled: false,
    };
  });
}

// ---------------------------------------------------------------------------
// ANULACION: devolucion integra
// ---------------------------------------------------------------------------

/**
 * Anula la partida y devuelve intacta la apuesta de cada jugador.
 *
 * Se usa cuando el escrow quedo hecho pero la partida no pudo jugarse: fallo
 * del servidor, desconexion de ambos, o el sweeper limpiando una sala huerfana.
 * Sin rake: si no hubo juego, la casa no cobra.
 */
export async function voidMatch(params: {
  matchId: string;
  reason: EndReason;
}): Promise<{ refunded: number; balances: Record<string, WalletBalance>; alreadySettled: boolean }> {
  const { matchId, reason } = params;

  return withTransaction(async (client) => {
    const matchRes = await client.query<{ status: string; settled_at: Date | null }>(
      "SELECT status, settled_at FROM matches WHERE id = $1 FOR UPDATE",
      [matchId],
    );
    const match = matchRes.rows[0];
    if (!match) throw new WalletError("partida inexistente", "match_not_found", { matchId });

    if (match.settled_at !== null) {
      return { refunded: 0, balances: {}, alreadySettled: true };
    }
    if (match.status === "matchmaking") {
      // Nunca hubo escrow: solo se marca cancelada.
      await client.query(
        `UPDATE matches SET status = 'cancelled', end_reason = $2,
                            ended_at = now(), settled_at = now(),
                            pot = 0, rake = 0, payout = 0
          WHERE id = $1`,
        [matchId, reason],
      );
      return { refunded: 0, balances: {}, alreadySettled: false };
    }

    const playersRes = await client.query<{ user_id: string; stake_held: number }>(
      "SELECT user_id, stake_held FROM match_players WHERE match_id = $1 ORDER BY user_id",
      [matchId],
    );

    await lockWallets(
      client,
      playersRes.rows.map((p) => p.user_id),
    );

    const balances: Record<string, WalletBalance> = {};
    let refunded = 0;
    for (const player of playersRes.rows) {
      balances[player.user_id] = await applyEntry(client, {
        userId: player.user_id,
        matchId,
        kind: "BET_RELEASE",
        amount: player.stake_held,
        lockedDelta: -player.stake_held,
        idempotencyKey: `refund:${matchId}:${player.user_id}`,
        metadata: { reason },
      });
      refunded += player.stake_held;
    }

    await client.query("UPDATE match_players SET result = 'void' WHERE match_id = $1", [matchId]);
    await client.query(
      `UPDATE matches
          SET status = 'voided', end_reason = $2, pot = 0, rake = 0, payout = 0,
              ended_at = COALESCE(ended_at, now()), settled_at = now()
        WHERE id = $1`,
      [matchId, reason],
    );

    return { refunded, balances, alreadySettled: false };
  });
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}
