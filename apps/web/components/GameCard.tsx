"use client";

import { motion } from "framer-motion";
import { Flame, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";

interface GameCardProps {
  title: string;
  subtitle: string;
  icon: LucideIcon;
  accent: string;
  accentGlow: string;
  active: boolean;
  trending: boolean;
  /** Jugadores estimados en partida ahora mismo (2 por partida activa). Null si aún no se sabe. */
  liveCount: number | null;
  onSelect: () => void;
}

/** Tarjeta grande de seleccion de juego, con glow y zoom suave al pasar el mouse. */
export function GameCard({
  title,
  subtitle,
  icon: Icon,
  accent,
  accentGlow,
  active,
  trending,
  liveCount,
  onSelect,
}: GameCardProps) {
  return (
    <motion.button
      type="button"
      className={`game-card ${active ? "game-card-active" : ""}`}
      style={{ ["--accent" as string]: accent, ["--accent-glow" as string]: accentGlow }}
      onClick={onSelect}
      whileHover={{ scale: 1.015 }}
      whileTap={{ scale: 0.99 }}
      transition={{ type: "spring", stiffness: 300, damping: 22 }}
    >
      <span className="game-card-glow" aria-hidden />
      <span className="game-card-icon-badge">
        <Icon size={22} strokeWidth={2.2} aria-hidden />
      </span>
      <h3 className="game-card-title">{title}</h3>
      <p className="game-card-sub">{subtitle}</p>
      <div className="game-card-badges">
        {trending && (
          <span className="game-badge game-badge-trend">
            <Flame size={11} strokeWidth={2.4} />
            En tendencia
          </span>
        )}
        {liveCount !== null && liveCount > 0 && (
          <span className="game-badge game-badge-live">
            <Users size={11} strokeWidth={2.4} />~{liveCount} en partida
          </span>
        )}
      </div>
    </motion.button>
  );
}
