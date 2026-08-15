"use client";

import { useEffect, useState } from "react";
import { formatCOP } from "@ah/shared";

interface Win {
  name: string;
  payout: number;
  game: "air_hockey" | "mines";
  at: string;
}

const GAME_LABEL: Record<Win["game"], string> = {
  air_hockey: "Air Hockey",
  mines: "Minas 1v1",
};

const GAME_ICON: Record<Win["game"], string> = {
  air_hockey: "🔥",
  mines: "💎",
};

/**
 * Ticker de ganadores recientes, tipo casino. Datos reales de
 * `/api/activity/recent-wins` (partidas ya liquidadas) — no se inventan
 * nombres ni montos.
 *
 * El desplazamiento continuo es una animacion CSS (`.ticker-track`, ver
 * globals.css) sobre la lista duplicada dos veces: mas robusto para un loop
 * infinito sin saltos que orquestarlo a mano con JS.
 */
export function LiveTicker({ apiBase }: { apiBase: string }) {
  const [wins, setWins] = useState<Win[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${apiBase}/api/activity/recent-wins`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setWins(data.wins);
      } catch {
        // El ticker es ambiente, no informacion critica: falla en silencio.
      }
    };
    void load();
    const id = setInterval(load, 20_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [apiBase]);

  if (wins !== null && wins.length === 0) {
    return (
      <div className="ticker-bar">
        <p className="ticker-empty">Aún no hay ganadores recientes. ¡Sé el primero de hoy!</p>
      </div>
    );
  }

  if (!wins || wins.length === 0) return <div className="ticker-bar" aria-hidden />;

  const items = [...wins, ...wins];

  return (
    <div className="ticker-bar">
      <div className="ticker-track">
        {items.map((win, i) => (
          <span className="ticker-item" key={`${win.at}-${i}`}>
            {GAME_ICON[win.game]} <strong>@{win.name}</strong> acaba de ganar{" "}
            <span className="ticker-amount">{formatCOP(win.payout)}</span> en {GAME_LABEL[win.game]}
          </span>
        ))}
      </div>
    </div>
  );
}
