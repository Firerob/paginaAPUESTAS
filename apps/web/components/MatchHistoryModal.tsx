"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { formatCOP } from "@ah/shared";

interface MatchRow {
  id: string;
  stake: number;
  status: string;
  end_reason: string | null;
  score_home: number;
  score_away: number;
  pot: number | null;
  rake: number | null;
  payout: number | null;
  winner_user_id: string | null;
  created_at: string;
  ended_at: string | null;
  seat: 0 | 1;
  result: "win" | "loss" | "void" | null;
}

interface MatchHistoryModalProps {
  open: boolean;
  onClose: () => void;
  token: string;
  apiBase: string;
}

const RESULT_LABEL: Record<string, string> = {
  win: "Ganada",
  loss: "Perdida",
  void: "Anulada",
};

/** Historial de partidas del jugador autenticado, via GET /api/me/matches. */
export function MatchHistoryModal({ open, onClose, token, apiBase }: MatchHistoryModalProps) {
  const [matches, setMatches] = useState<MatchRow[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setBusy(true);
    fetch(`${apiBase}/api/me/matches`, { headers: { authorization: `Bearer ${token}` } })
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setMatches(data.matches);
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, token, apiBase]);

  if (!open) return null;

  return (
    <div
      className="cajero-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cajero-modal glass" role="dialog" aria-modal="true" aria-label="Historial de partidas">
        <div className="cajero-head">
          <h2 className="cajero-title">Historial de partidas</h2>
          <button className="cajero-close" onClick={onClose} aria-label="Cerrar">
            <X size={16} strokeWidth={2.4} />
          </button>
        </div>

        <div className="cajero-body">
          {busy && !matches ? (
            <p className="cajero-hint">Cargando…</p>
          ) : matches && matches.length > 0 ? (
            <div className="cajero-history-list">
              {matches.map((m) => (
                <div key={m.id} className="cajero-history-row">
                  <span
                    className={`cajero-history-dot ${
                      m.result === "win"
                        ? "cajero-history-dot-completed"
                        : m.result === "loss"
                          ? "cajero-history-dot-failed"
                          : "cajero-history-dot-pending"
                    }`}
                  />
                  <span className="cajero-history-info">
                    <span className="cajero-history-title">
                      {m.result ? RESULT_LABEL[m.result] : m.status} · {formatCOP(m.stake)} ·{" "}
                      {m.score_home}-{m.score_away}
                    </span>
                    <span className="cajero-history-date">
                      {new Date(m.created_at).toLocaleString("es-CO")}
                    </span>
                  </span>
                  <span className="cajero-history-amount">
                    {m.result === "win" && m.payout ? `+${formatCOP(m.payout)}` : ""}
                    {m.result === "loss" ? `-${formatCOP(m.stake)}` : ""}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="cajero-hint">Todavía no has jugado ninguna partida.</p>
          )}
        </div>
      </div>
    </div>
  );
}
