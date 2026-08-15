"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Building2, CreditCard, Gift, History, Smartphone, X } from "lucide-react";
import { formatCOP } from "@ah/shared";

export type PaymentMethod = "NEQUI" | "DAVIPLATA" | "PSE" | "CARD";

export interface WalletSnapshot {
  /** Saldo total jugable (depositado + ganado). */
  available: number;
  /** Subconjunto de `available` que se puede retirar. */
  withdrawable: number;
  /** Saldo de bonos/promociones, no retirable. */
  bonus: number;
}

const MIN_DEPOSIT_COP = 5000;
const QUICK_AMOUNTS = [5000, 10000, 20000];

const METHODS: Array<{
  id: PaymentMethod;
  label: string;
  hint: string;
  badge: string;
  icon: typeof Smartphone;
  glow: string;
}> = [
  {
    id: "NEQUI",
    label: "Nequi directo",
    hint: "Aprueba el push en tu app",
    badge: "Instantáneo",
    icon: Smartphone,
    glow: "rgba(255, 47, 142, 0.18)",
  },
  {
    id: "DAVIPLATA",
    label: "DaviPlata directo",
    hint: "Aprueba el push en tu app",
    badge: "Instantáneo",
    icon: Smartphone,
    glow: "rgba(255, 93, 30, 0.18)",
  },
  {
    id: "PSE",
    label: "PSE",
    hint: "Todos los bancos colombianos",
    badge: "1-3 min",
    icon: Building2,
    glow: "rgba(34, 232, 255, 0.18)",
  },
  {
    id: "CARD",
    label: "Tarjeta crédito / débito",
    hint: "Visa, Mastercard",
    badge: "Instantáneo",
    icon: CreditCard,
    glow: "rgba(255, 207, 92, 0.18)",
  },
];

type CajeroTab = "deposit" | "withdraw";

interface CashierTransactionRow {
  id: string;
  type: "DEPOSIT" | "WITHDRAWAL";
  method: PaymentMethod;
  formatted: string;
  status: "PENDING" | "COMPLETED" | "FAILED" | "CANCELLED";
  createdAt: string;
}

interface CajeroModalProps {
  open: boolean;
  onClose: () => void;
  initialTab?: CajeroTab;
  token: string;
  apiBase: string;
  balance: WalletSnapshot | null;
  onBalanceChange: (balance: WalletSnapshot) => void;
}

/**
 * Cajero: deposito y retiro de saldo con metodos colombianos.
 *
 * El monto minimo de recarga ($5.000 COP) se valida aqui para dar feedback
 * inmediato, pero la garantia real vive en el servidor (constraint
 * `deposit_min_amount` en cashier_transactions): esta pantalla nunca es la
 * unica linea de defensa.
 */
export function CajeroModal({
  open,
  onClose,
  initialTab = "deposit",
  token,
  apiBase,
  balance,
  onBalanceChange,
}: CajeroModalProps) {
  const [tab, setTab] = useState<CajeroTab>(initialTab);
  const [method, setMethod] = useState<PaymentMethod>("NEQUI");
  const [amountInput, setAmountInput] = useState(String(MIN_DEPOSIT_COP));
  const [destination, setDestination] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [view, setView] = useState<"form" | "history">("form");
  const [history, setHistory] = useState<CashierTransactionRow[] | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setTab(initialTab);
      setError(null);
      setSuccess(null);
      setView("form");
    }
  }, [open, initialTab]);

  const openHistory = async (): Promise<void> => {
    setView("history");
    setHistoryBusy(true);
    try {
      const response = await fetch(`${apiBase}/api/me/cashier/transactions`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const data = await response.json();
      if (response.ok) setHistory(data.transactions);
    } finally {
      setHistoryBusy(false);
    }
  };

  const amount = useMemo(() => {
    const parsed = Number.parseInt(amountInput.replace(/\D/g, ""), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }, [amountInput]);

  const amountValid =
    tab === "deposit"
      ? Number.isInteger(amount) && amount >= MIN_DEPOSIT_COP
      : Number.isInteger(amount) &&
        amount > 0 &&
        (!balance || amount <= balance.withdrawable);

  if (!open) return null;

  const submit = async (): Promise<void> => {
    if (!amountValid || busy) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const path = tab === "deposit" ? "/api/cashier/deposit" : "/api/cashier/withdrawal";
      const body =
        tab === "deposit"
          ? { amount, method }
          : { amount, method, destination: { account: destination } };

      const response = await fetch(`${apiBase}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(errorMessage(data.error));
      }

      setSuccess(
        tab === "deposit"
          ? `Recarga de ${formatCOP(amount)} confirmada.`
          : `Retiro de ${formatCOP(amount)} en proceso.`,
      );

      const balanceRes = await fetch(`${apiBase}/api/me/balance`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (balanceRes.ok) {
        const fresh = await balanceRes.json();
        onBalanceChange({
          available: fresh.available,
          withdrawable: fresh.withdrawable,
          bonus: fresh.bonus,
        });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="cajero-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cajero-modal glass" role="dialog" aria-modal="true" aria-label="Cajero">
        <div className="cajero-head">
          {view === "history" ? (
            <button className="cajero-close" onClick={() => setView("form")} aria-label="Volver">
              <ArrowLeft size={16} strokeWidth={2.4} />
            </button>
          ) : (
            <h2 className="cajero-title">Cajero</h2>
          )}
          {view === "history" ? <h2 className="cajero-title">Historial</h2> : null}
          <button className="cajero-close" onClick={onClose} aria-label="Cerrar">
            <X size={16} strokeWidth={2.4} />
          </button>
        </div>

        <div className="cajero-breakdown">
          <div className="cajero-breakdown-item">
            <p className="cajero-breakdown-label">Saldo total</p>
            <p className="cajero-breakdown-value">
              {balance ? formatCOP(balance.available) : "—"}
            </p>
          </div>
          <div className="cajero-breakdown-item cajero-breakdown-item-withdrawable">
            <p className="cajero-breakdown-label">Retirable</p>
            <p className="cajero-breakdown-value">
              {balance ? formatCOP(balance.withdrawable) : "—"}
            </p>
          </div>
          <div className="cajero-breakdown-item cajero-breakdown-item-bonus">
            <p className="cajero-breakdown-label">Bono activo</p>
            <p className="cajero-breakdown-value">
              {balance ? formatCOP(balance.bonus) : "—"}
            </p>
          </div>
        </div>

        {view === "form" ? (
          <div className="cajero-tabs">
            <button
              className={`cajero-tab ${tab === "deposit" ? "cajero-tab-active" : ""}`}
              onClick={() => {
                setTab("deposit");
                setAmountInput(String(MIN_DEPOSIT_COP));
                setError(null);
                setSuccess(null);
              }}
            >
              Depósitos
            </button>
            <button
              className={`cajero-tab ${tab === "withdraw" ? "cajero-tab-active" : ""}`}
              onClick={() => {
                setTab("withdraw");
                setAmountInput("0");
                setError(null);
                setSuccess(null);
              }}
            >
              Retiros
            </button>
          </div>
        ) : null}

        {view === "history" ? (
          <div className="cajero-body">
            {historyBusy && !history ? (
              <p className="cajero-hint">Cargando…</p>
            ) : history && history.length > 0 ? (
              <div className="cajero-history-list">
                {history.map((row) => (
                  <div key={row.id} className="cajero-history-row">
                    <span className={`cajero-history-dot cajero-history-dot-${row.status.toLowerCase()}`} />
                    <span className="cajero-history-info">
                      <span className="cajero-history-title">
                        {row.type === "DEPOSIT" ? "Depósito" : "Retiro"} · {methodLabel(row.method)}
                      </span>
                      <span className="cajero-history-date">
                        {new Date(row.createdAt).toLocaleString("es-CO")}
                      </span>
                    </span>
                    <span className="cajero-history-amount">{row.formatted}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="cajero-hint">Todavía no tienes movimientos en el cajero.</p>
            )}
          </div>
        ) : (
        <div className="cajero-body">
          <div>
            <label className="cajero-field-label" htmlFor="cajero-amount">
              {tab === "deposit" ? "Monto a recargar" : "Monto a retirar"}
            </label>
            <input
              id="cajero-amount"
              className={`cajero-amount-input ${!amountValid && amountInput !== "" ? "cajero-amount-input-invalid" : ""}`}
              inputMode="numeric"
              value={amountInput}
              onChange={(e) => setAmountInput(e.target.value)}
            />
            {tab === "deposit" ? (
              <div className="cajero-quick-row">
                {QUICK_AMOUNTS.map((tier) => (
                  <button
                    key={tier}
                    type="button"
                    className="cajero-quick-btn"
                    onClick={() => setAmountInput(String(amount + tier))}
                  >
                    +{formatCOP(tier)}
                  </button>
                ))}
              </div>
            ) : null}
            {tab === "deposit" && !amountValid ? (
              <p className="cajero-hint cajero-hint-error">
                La recarga mínima es de {formatCOP(MIN_DEPOSIT_COP)}.
              </p>
            ) : null}
            {tab === "withdraw" && !amountValid ? (
              <p className="cajero-hint cajero-hint-error">
                No puedes retirar más de tu saldo retirable
                {balance ? ` (${formatCOP(balance.withdrawable)})` : ""}.
              </p>
            ) : null}
          </div>

          {tab === "withdraw" ? (
            <div>
              <label className="cajero-field-label" htmlFor="cajero-destination">
                Cuenta / número de destino
              </label>
              <input
                id="cajero-destination"
                className="cajero-destination-input"
                placeholder={method === "PSE" || method === "CARD" ? "Número de cuenta" : "Número de celular"}
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
              />
            </div>
          ) : null}

          <div>
            <label className="cajero-field-label">Método de pago</label>
            <div className="cajero-methods">
              {METHODS.map((m) => {
                const Icon = m.icon;
                const active = method === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    className={`cajero-method ${active ? "cajero-method-active" : ""}`}
                    onClick={() => setMethod(m.id)}
                  >
                    <span className="cajero-method-icon" style={{ background: m.glow }}>
                      <Icon size={18} strokeWidth={2} />
                    </span>
                    <span className="cajero-method-body">
                      <span className="cajero-method-name">{m.label}</span>
                      <span className="cajero-method-hint">{m.hint}</span>
                    </span>
                    <span className="cajero-method-badge">{m.badge}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {error ? <p className="cajero-hint cajero-hint-error">{error}</p> : null}
          {success ? <p className="cajero-hint cajero-hint-ok">{success}</p> : null}

          <button
            className="btn btn-gold"
            style={{ width: "100%" }}
            disabled={!amountValid || busy || (tab === "withdraw" && destination.trim() === "")}
            onClick={() => void submit()}
          >
            {busy
              ? "Procesando…"
              : tab === "deposit"
                ? `Recargar ${amount > 0 ? formatCOP(amount) : ""}`
                : `Retirar ${amount > 0 ? formatCOP(amount) : ""}`}
          </button>
        </div>
        )}

        {view === "form" ? (
          <div className="cajero-footer">
            <button className="cajero-footer-link" onClick={() => void openHistory()}>
              <History size={14} strokeWidth={2.2} />
              Historial de transacciones
            </button>
            <button className="cajero-footer-link" disabled title="Próximamente">
              <Gift size={14} strokeWidth={2.2} />
              Agregar bonificación
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function methodLabel(method: PaymentMethod): string {
  const found = METHODS.find((m) => m.id === method);
  return found ? found.label : method;
}

function errorMessage(code: string | undefined): string {
  switch (code) {
    case "invalid_amount":
      return "El monto no es válido.";
    case "insufficient_funds":
      return "No tienes saldo retirable suficiente.";
    case "invalid_request":
      return "Revisa el monto y el método de pago.";
    default:
      return "No se pudo completar la operación. Intenta de nuevo.";
  }
}
