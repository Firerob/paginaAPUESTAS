"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Flame, MoreVertical, Users, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";

interface GameCardProps {
  title: string;
  subtitle: string;
  /** Explicacion corta de las reglas, para el popover de los 3 puntos. */
  rules: string;
  icon: LucideIcon;
  accent: string;
  accentGlow: string;
  active: boolean;
  trending: boolean;
  /** Jugadores estimados en partida ahora mismo (2 por partida activa). Null si aún no se sabe. */
  liveCount: number | null;
  onSelect: () => void;
}

/**
 * Tarjeta grande de seleccion de juego, con glow y zoom suave al pasar el
 * mouse. El boton de 3 puntos abre un panel de reglas DENTRO de la propia
 * tarjeta (no un tooltip flotante que se saldria de `.game-card`, que recorta
 * con `overflow: hidden` para el glow) — por eso el wrapper raiz es un `div`
 * con `role="button"` en vez de un `<button>`: adentro conviven el click de
 * "elegir juego" y el boton real de "info", y un `<button>` dentro de otro
 * `<button>` es HTML invalido.
 */
export function GameCard({
  title,
  subtitle,
  rules,
  icon: Icon,
  accent,
  accentGlow,
  active,
  trending,
  liveCount,
  onSelect,
}: GameCardProps) {
  const [infoOpen, setInfoOpen] = useState(false);

  return (
    <motion.div
      role="button"
      tabIndex={0}
      className={`game-card ${active ? "game-card-active" : ""}`}
      style={{ ["--accent" as string]: accent, ["--accent-glow" as string]: accentGlow }}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      whileHover={{ scale: 1.015 }}
      whileTap={{ scale: 0.99 }}
      transition={{ type: "spring", stiffness: 300, damping: 22 }}
    >
      <span className="game-card-glow" aria-hidden />

      <button
        type="button"
        className="game-card-info-btn"
        aria-label={`Reglas de ${title}`}
        aria-expanded={infoOpen}
        onClick={(e) => {
          e.stopPropagation();
          setInfoOpen((v) => !v);
        }}
      >
        <MoreVertical size={16} strokeWidth={2.4} aria-hidden />
      </button>

      <span className="game-card-icon-badge">
        <Icon size={28} strokeWidth={2.2} aria-hidden />
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

      {infoOpen && (
        <div
          className="game-card-info-panel"
          onClick={(e) => {
            e.stopPropagation();
            setInfoOpen(false);
          }}
        >
          <button
            type="button"
            className="game-card-info-close"
            aria-label="Cerrar"
            onClick={(e) => {
              e.stopPropagation();
              setInfoOpen(false);
            }}
          >
            <X size={14} strokeWidth={2.4} aria-hidden />
          </button>
          <h4 className="game-card-info-title">{title}</h4>
          <p className="game-card-info-text">{rules}</p>
        </div>
      )}
    </motion.div>
  );
}
