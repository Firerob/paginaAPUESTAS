import * as crypto from "node:crypto";
import { pool, withTransaction } from "../db/pool";
import { applyEntry, WalletError, type WalletBalance } from "./wallet.service";
import { getPaymentProvider, type PaymentMethod } from "./payment-providers";

/**
 * Cajero: depositos y retiros con metodos de pago colombianos.
 *
 * Reglas, en el mismo espiritu que wallet.service.ts:
 *
 *  1. Un retiro descuenta el saldo AL MOMENTO DE SOLICITARLO, no cuando la
 *     pasarela confirma. Si no fuera asi, el usuario podria apostar el mismo
 *     dinero mientras el retiro esta "pendiente" en el banco.
 *  2. Un deposito acredita saldo SOLO cuando la pasarela confirma el pago,
 *     nunca antes: nadie cobra por dinero que todavia no llego.
 *  3. Cada movimiento de saldo pasa por `applyEntry`, la misma funcion que
 *     usa el escrow de partidas: mismas garantias de idempotencia y de
 *     no-negatividad via CHECK constraints.
 *  4. Llamar a la pasarela es I/O externo y NUNCA ocurre dentro de una
 *     transaccion de Postgres: una transaccion abierta esperando una
 *     respuesta de red retiene locks mas de la cuenta.
 */

export const MIN_DEPOSIT_COP = 5000;

export class CashierError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_amount"
      | "insufficient_funds"
      | "transaction_not_found"
      | "already_resolved",
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CashierError";
  }
}

export interface CashierTransaction {
  id: string;
  userId: string;
  type: "DEPOSIT" | "WITHDRAWAL";
  method: PaymentMethod;
  amount: number;
  status: "PENDING" | "COMPLETED" | "FAILED" | "CANCELLED";
  provider: string;
  providerRef: string | null;
  instructions?: string;
  redirectUrl?: string;
  createdAt: Date;
  completedAt: Date | null;
}

interface TxRow {
  id: string;
  user_id: string;
  type: "DEPOSIT" | "WITHDRAWAL";
  method: PaymentMethod;
  amount: number;
  status: "PENDING" | "COMPLETED" | "FAILED" | "CANCELLED";
  provider: string;
  provider_ref: string | null;
  created_at: Date;
  completed_at: Date | null;
}

function toCashierTransaction(row: TxRow): CashierTransaction {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    method: row.method,
    amount: row.amount,
    status: row.status,
    provider: row.provider,
    providerRef: row.provider_ref,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function assertValidAmount(amount: number): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new CashierError("monto invalido", "invalid_amount", { amount });
  }
}

// ---------------------------------------------------------------------------
// DEPOSITOS
// ---------------------------------------------------------------------------

export async function createDeposit(params: {
  userId: string;
  amount: number;
  method: PaymentMethod;
}): Promise<CashierTransaction & { instructions?: string; redirectUrl?: string }> {
  const { userId, amount, method } = params;
  assertValidAmount(amount);
  if (amount < MIN_DEPOSIT_COP) {
    throw new CashierError(`la recarga minima es de ${MIN_DEPOSIT_COP} COP`, "invalid_amount", {
      amount,
      min: MIN_DEPOSIT_COP,
    });
  }

  const provider = getPaymentProvider();

  const { rows } = await pool.query<TxRow>(
    `INSERT INTO cashier_transactions (user_id, type, method, amount, provider, idempotency_key)
     VALUES ($1, 'DEPOSIT', $2, $3, $4, $5)
     RETURNING *`,
    [userId, method, amount, provider.name, `deposit-init:${userId}:${crypto.randomUUID()}`],
  );
  const tx = rows[0];

  const intent = await provider.createDeposit({ transactionId: tx.id, userId, amount, method });

  await pool.query(`UPDATE cashier_transactions SET provider_ref = $2 WHERE id = $1`, [
    tx.id,
    intent.providerRef,
  ]);

  if (intent.settledImmediately) {
    const settled = await confirmDeposit({ transactionId: tx.id, providerRef: intent.providerRef });
    return { ...settled, instructions: intent.instructions, redirectUrl: intent.redirectUrl };
  }

  return {
    ...toCashierTransaction({ ...tx, provider_ref: intent.providerRef }),
    instructions: intent.instructions,
    redirectUrl: intent.redirectUrl,
  };
}

/**
 * Confirma un deposito (llamado por el webhook de la pasarela, o de
 * inmediato por el adaptador mock). Acredita el saldo. Idempotente: si el
 * webhook llega dos veces, la segunda es un no-op.
 */
export async function confirmDeposit(params: {
  transactionId: string;
  providerRef: string;
}): Promise<CashierTransaction & { balance?: WalletBalance }> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<TxRow>(
      "SELECT * FROM cashier_transactions WHERE id = $1 FOR UPDATE",
      [params.transactionId],
    );
    const tx = rows[0];
    if (!tx) {
      throw new CashierError("transaccion inexistente", "transaction_not_found", {
        transactionId: params.transactionId,
      });
    }
    if (tx.type !== "DEPOSIT") {
      throw new CashierError("no es un deposito", "already_resolved", { transactionId: tx.id });
    }
    if (tx.status === "COMPLETED") {
      return toCashierTransaction(tx);
    }
    if (tx.status !== "PENDING") {
      throw new CashierError(`no se puede confirmar en estado ${tx.status}`, "already_resolved", {
        transactionId: tx.id,
      });
    }

    const balance = await applyEntry(client, {
      userId: tx.user_id,
      matchId: null,
      kind: "DEPOSIT",
      amount: tx.amount,
      lockedDelta: 0,
      idempotencyKey: `deposit:${tx.id}`,
      metadata: { method: tx.method, cashierTransactionId: tx.id, providerRef: params.providerRef },
    });

    const { rows: updated } = await client.query<TxRow>(
      `UPDATE cashier_transactions
          SET status = 'COMPLETED', provider_ref = $2, completed_at = now()
        WHERE id = $1
        RETURNING *`,
      [tx.id, params.providerRef],
    );

    return { ...toCashierTransaction(updated[0]), balance };
  });
}

export async function failDeposit(params: { transactionId: string; reason: string }): Promise<void> {
  await pool.query(
    `UPDATE cashier_transactions
        SET status = 'FAILED', failure_reason = $2
      WHERE id = $1 AND status = 'PENDING'`,
    [params.transactionId, params.reason],
  );
}

// ---------------------------------------------------------------------------
// RETIROS
// ---------------------------------------------------------------------------

export async function createWithdrawal(params: {
  userId: string;
  amount: number;
  method: PaymentMethod;
  destination: Record<string, unknown>;
}): Promise<CashierTransaction> {
  const { userId, amount, method, destination } = params;
  assertValidAmount(amount);

  const provider = getPaymentProvider();

  // Paso 1: retener el saldo YA, dentro de una transaccion. Si no alcanza,
  // no se crea ningun registro y nada se mueve.
  const tx = await withTransaction(async (client) => {
    const { rows: walletRows } = await client.query<{ withdrawable: number }>(
      "SELECT withdrawable FROM wallets WHERE user_id = $1 FOR UPDATE",
      [userId],
    );
    const wallet = walletRows[0];
    if (!wallet) throw new WalletError("wallet inexistente", "wallet_missing", { userId });
    if (wallet.withdrawable < amount) {
      throw new CashierError("saldo retirable insuficiente", "insufficient_funds", {
        userId,
        available: wallet.withdrawable,
        requested: amount,
      });
    }

    const { rows } = await client.query<TxRow>(
      `INSERT INTO cashier_transactions
         (user_id, type, method, amount, provider, destination, idempotency_key)
       VALUES ($1, 'WITHDRAWAL', $2, $3, $4, $5::jsonb, $6)
       RETURNING *`,
      [userId, method, amount, provider.name, JSON.stringify(destination), `withdrawal-init:${userId}:${crypto.randomUUID()}`],
    );
    const created = rows[0];

    await applyEntry(client, {
      userId,
      matchId: null,
      kind: "WITHDRAWAL",
      amount: -amount,
      lockedDelta: 0,
      idempotencyKey: `withdrawal:${created.id}`,
      metadata: { method, cashierTransactionId: created.id },
    });

    return created;
  });

  // Paso 2: fuera de la transaccion, avisar a la pasarela.
  try {
    const intent = await provider.createWithdrawal({
      transactionId: tx.id,
      userId,
      amount,
      method,
      destination,
    });
    await pool.query(`UPDATE cashier_transactions SET provider_ref = $2 WHERE id = $1`, [
      tx.id,
      intent.providerRef,
    ]);
    if (intent.settledImmediately) {
      return await confirmWithdrawal({ transactionId: tx.id, providerRef: intent.providerRef });
    }
    return toCashierTransaction({ ...tx, provider_ref: intent.providerRef });
  } catch (error) {
    // La pasarela rechazo o fallo la llamada: se devuelve el dinero.
    await failWithdrawal({
      transactionId: tx.id,
      reason: error instanceof Error ? error.message : "provider_error",
    });
    throw error;
  }
}

export async function confirmWithdrawal(params: {
  transactionId: string;
  providerRef: string;
}): Promise<CashierTransaction> {
  const { rows } = await pool.query<TxRow>(
    `UPDATE cashier_transactions
        SET status = 'COMPLETED', provider_ref = $2, completed_at = now()
      WHERE id = $1 AND status = 'PENDING'
      RETURNING *`,
    [params.transactionId, params.providerRef],
  );
  if (rows[0]) return toCashierTransaction(rows[0]);

  const { rows: existing } = await pool.query<TxRow>("SELECT * FROM cashier_transactions WHERE id = $1", [
    params.transactionId,
  ]);
  if (!existing[0]) {
    throw new CashierError("transaccion inexistente", "transaction_not_found", {
      transactionId: params.transactionId,
    });
  }
  return toCashierTransaction(existing[0]);
}

/** Falla un retiro y devuelve el dinero retenido, con motivo. */
export async function failWithdrawal(params: { transactionId: string; reason: string }): Promise<void> {
  await withTransaction(async (client) => {
    const { rows } = await client.query<TxRow>(
      "SELECT * FROM cashier_transactions WHERE id = $1 FOR UPDATE",
      [params.transactionId],
    );
    const tx = rows[0];
    if (!tx || tx.status !== "PENDING") return; // ya resuelta o no existe: no-op

    await client.query(
      `UPDATE cashier_transactions
          SET status = 'FAILED', failure_reason = $2
        WHERE id = $1`,
      [tx.id, params.reason],
    );

    await applyEntry(client, {
      userId: tx.user_id,
      matchId: null,
      kind: "ADJUSTMENT",
      amount: tx.amount,
      lockedDelta: 0,
      idempotencyKey: `withdrawal-refund:${tx.id}`,
      metadata: { reason: params.reason, cashierTransactionId: tx.id, refundOf: "WITHDRAWAL" },
    });
  });
}

// ---------------------------------------------------------------------------
// CONSULTA
// ---------------------------------------------------------------------------

export async function listTransactions(userId: string, limit = 50): Promise<CashierTransaction[]> {
  const { rows } = await pool.query<TxRow>(
    `SELECT * FROM cashier_transactions
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [userId, limit],
  );
  return rows.map(toCashierTransaction);
}
