import { Router, type Request, type Response } from "express";
import { formatCOP } from "@ah/shared";
import { requireAuth } from "./auth.middleware";
import {
  CashierError,
  MIN_DEPOSIT_COP,
  createDeposit,
  createWithdrawal,
  listTransactions,
} from "../services/cashier.service";
import { WalletError } from "../services/wallet.service";
import type { PaymentMethod } from "../services/payment-providers";

export const cashierRoutes = Router();

const METHODS: readonly PaymentMethod[] = ["NEQUI", "DAVIPLATA", "PSE", "CARD"];

function isMethod(value: unknown): value is PaymentMethod {
  return typeof value === "string" && (METHODS as readonly string[]).includes(value);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** Deposito: recarga con Nequi, DaviPlata, PSE o tarjeta. Minimo 5.000 COP. */
cashierRoutes.post("/api/cashier/deposit", async (req: Request, res: Response) => {
  const userId = await requireAuth(req, res);
  if (!userId) return;

  const { amount, method } = req.body ?? {};
  if (!isPositiveInt(amount) || !isMethod(method)) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }

  try {
    const tx = await createDeposit({ userId, amount, method });
    res.status(201).json({
      id: tx.id,
      status: tx.status,
      amount: tx.amount,
      formatted: formatCOP(tx.amount),
      method: tx.method,
      instructions: tx.instructions,
      redirectUrl: tx.redirectUrl,
    });
  } catch (error) {
    handleCashierError(error, res);
  }
});

/** Retiro: descuenta el saldo retirable de inmediato y encola el pago. */
cashierRoutes.post("/api/cashier/withdrawal", async (req: Request, res: Response) => {
  const userId = await requireAuth(req, res);
  if (!userId) return;

  const { amount, method, destination } = req.body ?? {};
  if (!isPositiveInt(amount) || !isMethod(method)) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }

  try {
    const tx = await createWithdrawal({
      userId,
      amount,
      method,
      destination: typeof destination === "object" && destination !== null ? destination : {},
    });
    res.status(201).json({
      id: tx.id,
      status: tx.status,
      amount: tx.amount,
      formatted: formatCOP(tx.amount),
      method: tx.method,
    });
  } catch (error) {
    handleCashierError(error, res);
  }
});

/** Historial del cajero: depositos y retiros, mas legible que el diario contable crudo. */
cashierRoutes.get("/api/me/cashier/transactions", async (req: Request, res: Response) => {
  const userId = await requireAuth(req, res);
  if (!userId) return;

  const transactions = await listTransactions(userId);
  res.json({
    transactions: transactions.map((tx) => ({
      id: tx.id,
      type: tx.type,
      method: tx.method,
      amount: tx.amount,
      formatted: formatCOP(tx.amount),
      status: tx.status,
      createdAt: tx.createdAt,
      completedAt: tx.completedAt,
    })),
    minDeposit: MIN_DEPOSIT_COP,
  });
});

function handleCashierError(error: unknown, res: Response): void {
  if (error instanceof CashierError) {
    const status = error.code === "insufficient_funds" ? 409 : 400;
    res.status(status).json({ error: error.code, ...error.details });
    return;
  }
  if (error instanceof WalletError) {
    res.status(error.code === "insufficient_funds" ? 409 : 400).json({ error: error.code });
    return;
  }
  console.error("[cashier] error inesperado", error);
  res.status(500).json({ error: "internal_error" });
}
