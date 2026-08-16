"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Home, RefreshCcw } from "lucide-react";
import { formatCOP } from "@ah/shared";
import { ConfettiSystem } from "@/lib/confetti";

export interface VictoryStat {
  icon: ReactNode;
  label: string;
  value: string;
}

interface VictoryScreenProps {
  /** Monto acreditado al ganador, en COP enteros. */
  payout: number;
  /** Comision de la plataforma sobre el pozo. */
  rake: number;
  /** Saldo disponible tras la liquidacion. */
  balanceAfter: number;
  /** Desglose especifico del juego: marcador, vidas, casillas, etc. */
  stats: VictoryStat[];
  /**
   * Vuelve a poner al jugador en cola con los mismos parametros. Quien la
   * implementa (la pagina, no este componente) fuerza el remount del
   * componente de juego — la forma mas simple y robusta de repetir
   * exactamente el mismo flujo de conexion que ya esta probado, en vez de
   * inventar un segundo camino de "reconexion sin desmontar".
   */
  onRematch: () => void;
}

const COUNT_UP_MS = 1500;

/**
 * Pantalla de victoria — experiencia "jackpot" de casino.
 *
 * Todo lo que hay aqui es celebracion, cero logica de juego: el pago ya se
 * liquido en el servidor antes de que este componente exista. Si se borrara
 * el archivo entero, el ganador se llevaria exactamente el mismo dinero —
 * solo se enteraria con menos fanfarria.
 */
export default function VictoryScreen({
  payout,
  rake,
  balanceAfter,
  stats,
  onRematch,
}: VictoryScreenProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [displayedPayout, setDisplayedPayout] = useState(0);

  // ---------------------------------------------------------------------
  // Contador: 0 -> pago final en COUNT_UP_MS, con una salida en desaceleracion
  // (easeOutExpo) para que el numero "frene" con fuerza sobre la cifra real
  // en vez de llegar plano — es lo que vende la sensacion de premio grande.
  // ---------------------------------------------------------------------
  useEffect(() => {
    let frame = 0;
    const start = performance.now();

    const tick = (now: number): void => {
      const t = Math.min(1, (now - start) / COUNT_UP_MS);
      const eased = t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
      setDisplayedPayout(Math.round(payout * eased));
      if (t < 1) frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [payout]);

  // ---------------------------------------------------------------------
  // Confeti y monedas: un cañonazo al montar, luego una llovizna suave que
  // sostiene el ambiente mientras la pantalla siga abierta.
  // ---------------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const confetti = new ConfettiSystem();
    let frame = 0;
    let last = performance.now();
    let elapsed = 0;

    const resize = (): void => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    confetti.burst(window.innerWidth, window.innerHeight, 0.3, 90);
    confetti.burst(window.innerWidth, window.innerHeight, 0.7, 90);

    const loop = (now: number): void => {
      frame = requestAnimationFrame(loop);
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      elapsed += dt;

      // La llovizna se sostiene 6 s y despues se corta: lo que ya esta en
      // el aire termina de caer solo, la celebracion no dura para siempre.
      if (elapsed < 6) confetti.drizzle(window.innerWidth, dt, 5);

      confetti.update(dt, window.innerHeight);
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      confetti.draw(ctx);
    };

    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <div className="jackpot-overlay">
      <div className="jackpot-strobe jackpot-strobe-gold" aria-hidden />
      <div className="jackpot-strobe jackpot-strobe-emerald" aria-hidden />
      <canvas ref={canvasRef} className="jackpot-confetti" aria-hidden />

      <div className="jackpot-card" role="dialog" aria-modal aria-label="Victoria">
        <h1 className="jackpot-title">
          <span className="jackpot-title-shimmer">¡JACKPOT RECLAMADO!</span>
        </h1>
        <p className="jackpot-subtitle">Pozo conquistado</p>

        <p className="jackpot-amount" aria-live="polite">
          +{formatCOP(displayedPayout)}
        </p>
        <p className="jackpot-rake">Comisión de plataforma: {formatCOP(rake)}</p>

        <div className="jackpot-stats">
          {stats.map((stat) => (
            <div key={stat.label} className="jackpot-stat">
              <span className="jackpot-stat-icon" aria-hidden>
                {stat.icon}
              </span>
              <span className="jackpot-stat-label">{stat.label}</span>
              <span className="jackpot-stat-value">{stat.value}</span>
            </div>
          ))}
        </div>

        <p className="jackpot-balance">Saldo disponible: {formatCOP(balanceAfter)}</p>

        <div className="jackpot-actions">
          <button type="button" className="btn-cta" onClick={onRematch}>
            <RefreshCcw size={20} strokeWidth={2.4} aria-hidden />
            Revancha instantánea
          </button>
          <Link className="btn btn-ghost" href="/">
            <Home size={16} strokeWidth={2.2} aria-hidden />
            Volver al lobby
          </Link>
        </div>
      </div>
    </div>
  );
}
