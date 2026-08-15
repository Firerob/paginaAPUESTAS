"use client";

import { useEffect, useState } from "react";
import { animate } from "framer-motion";
import { Radio, Trophy, Users } from "lucide-react";
import { formatCOP } from "@ah/shared";

export interface GameActivity {
  active: number;
  winsToday: number;
}

export interface ActivityStats {
  online: number;
  potToday: number;
  activeMatches: number;
  rakeBps: number;
  byGame: Record<"air_hockey" | "mines", GameActivity>;
  /**
   * Jugadores en cola o ya emparejados, por JUEGO y monto de apuesta.
   * Air Hockey y Minas nunca se suman entre si.
   */
  byStake: Record<"air_hockey" | "mines", Record<number, number>>;
  /** Solo Minas: jugadores en cola o emparejados por tamaño de tablero. */
  minesByBoard: Record<number, number>;
  /** Solo Minas: lo mismo, pero ademas separado por apuesta dentro de cada tablero. */
  minesByBoardStake: Record<number, Record<number, number>>;
}

/** Cuenta ascendente/descendente suave hacia `value` cada vez que cambia. */
function AnimatedNumber({ value, format }: { value: number; format?: (n: number) => string }) {
  const [display, setDisplay] = useState(value);

  useEffect(() => {
    const controls = animate(display, value, {
      duration: 0.7,
      ease: "easeOut",
      onUpdate: setDisplay,
    });
    return () => controls.stop();
    // Solo re-anima cuando cambia el valor objetivo, no el de pantalla.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const rounded = Math.round(display);
  return <>{format ? format(rounded) : rounded.toLocaleString("es-CO")}</>;
}

const CARDS: Array<{
  key: "online" | "potToday" | "activeMatches";
  label: string;
  icon: typeof Users;
  color: string;
  bg: string;
  format?: (n: number) => string;
}> = [
  { key: "online", label: "Jugadores conectados", icon: Users, color: "var(--cyan)", bg: "rgba(34, 232, 255, 0.14)" },
  {
    key: "potToday",
    label: "Pozo repartido hoy",
    icon: Trophy,
    color: "var(--gold)",
    bg: "rgba(255, 207, 92, 0.14)",
    format: formatCOP,
  },
  { key: "activeMatches", label: "Partidas en curso", icon: Radio, color: "var(--self)", bg: "rgba(43, 255, 176, 0.14)" },
];

/**
 * Panel de metricas en vivo del lobby. Puramente presentacional: recibe
 * `stats` ya cargado por el padre (que tambien lo comparte con las tarjetas
 * de juego y las fichas de apuesta) para no disparar el mismo fetch varias
 * veces por pantalla.
 */
export function StatsWidget({ stats }: { stats: ActivityStats | null }) {
  return (
    <div className="stats-row">
      {CARDS.map(({ key, label, icon: Icon, color, bg, format }) => (
        <div className="stat-card glass" key={key}>
          <span className="stat-icon" style={{ background: bg, color }}>
            <Icon size={20} strokeWidth={2.2} aria-hidden />
          </span>
          <div className="stat-body">
            <p className="stat-value">
              {stats ? <AnimatedNumber value={stats[key]} format={format} /> : "…"}
            </p>
            <p className="stat-label">{label}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
