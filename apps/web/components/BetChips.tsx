"use client";

import { motion } from "framer-motion";
import { Users } from "lucide-react";
import { computeSettlement, formatCOP } from "@ah/shared";

interface BetChipsProps {
  tiers: readonly number[];
  selected: number;
  onSelect: (tier: number) => void;
  /** Comision de la plataforma en basis points, para calcular la ganancia mostrada. */
  rakeBps: number;
  disabledBelow?: number;
  /**
   * Jugadores en cola o ya emparejados a ese monto ahora mismo, por apuesta.
   * Dato real de /api/activity/stats (cola en memoria + partidas activas en
   * la base); undefined mientras no haya llegado la primera respuesta.
   */
  onlineByStake?: Record<number, number>;
}

// Una entrada por apuesta, en el mismo orden que STAKE_TIERS en page.tsx.
// Las dos ultimas (50.000 y 100.000) usan una paleta mas fria y contenida
// a proposito, para que se lean como fichas de alto valor, no solo otro
// color mas del ciclo.
const CHIP_COLORS = [
  "var(--self)", // 1.000
  "var(--cyan)", // 5.000
  "var(--gold)", // 10.000
  "var(--purple)", // 20.000
  "var(--platinum)", // 50.000
  "var(--ruby)", // 100.000
] as const;

/** Selector de apuesta estilo fichas de casino, con la ganancia neta ya calculada. */
export function BetChips({
  tiers,
  selected,
  onSelect,
  rakeBps,
  disabledBelow,
  onlineByStake,
}: BetChipsProps) {
  return (
    <div className="chips-row">
      {tiers.map((tier, i) => {
        const { payout } = computeSettlement(tier, rakeBps);
        const color = CHIP_COLORS[i % CHIP_COLORS.length];
        const disabled = disabledBelow !== undefined && disabledBelow < tier;
        const online = onlineByStake?.[tier];
        return (
          <motion.button
            type="button"
            key={tier}
            className={`chip-card ${selected === tier ? "chip-card-active" : ""}`}
            style={{ ["--chip-color" as string]: color, opacity: disabled ? 0.4 : 1 }}
            onClick={() => onSelect(tier)}
            disabled={disabled}
            whileHover={disabled ? undefined : { y: -2 }}
            whileTap={disabled ? undefined : { scale: 0.95 }}
          >
            <span className="chip-disc">
              <span className="chip-disc-inner">{formatCOP(tier)}</span>
            </span>
            <span className="chip-win">
              Ganas <strong>{formatCOP(payout)}</strong>
            </span>
            <span className="chip-online">
              <Users size={11} strokeWidth={2.4} aria-hidden />
              {online !== undefined ? online : "…"} jugando
            </span>
          </motion.button>
        );
      })}
    </div>
  );
}
