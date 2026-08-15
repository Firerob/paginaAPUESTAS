"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Swords } from "lucide-react";
import { MINES_SIZES, formatCOP, minesFor, type MinesSize } from "@ah/shared";
import MinesBoard from "@/components/MinesBoard";

const ALLOWED_STAKES = [1000, 5000, 10000];

/**
 * Config -> Buscar partida -> Tablero.
 *
 * `connect()` (el equivalente local a `joinOrCreateMatch`) vive dentro de
 * `MinesBoard` y se dispara en su primer render. Por eso esta pantalla NUNCA
 * monta `MinesBoard` mientras el jugador todavia esta eligiendo: elegir
 * tamaño o apuesta aqui SOLO actualiza estado local (`size`, `stake`). El
 * socket, la cola de emparejamiento y el escrow no arrancan hasta que se
 * pulsa "Buscar partida".
 */
function MinesInner() {
  const params = useSearchParams();
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [searching, setSearching] = useState(false);
  // Cambiar la key fuerza un remount completo de MinesBoard: repite el
  // mismo flujo de conexion probado (nueva partida, mismos parametros) sin
  // volver a pasar por la pantalla de configuracion.
  const [matchKey, setMatchKey] = useState(0);
  const rematch = useCallback(() => {
    setMatchKey((key) => key + 1);
    setSearching(true);
  }, []);

  useEffect(() => {
    setToken(sessionStorage.getItem("ah:token"));
    setReady(true);
  }, []);

  // Los parametros de la URL (llegan del lobby) son solo una sugerencia
  // inicial para estos selectores: el servidor vuelve a validar todo contra
  // su propia lista antes de cobrar nada.
  const requestedStake = Number(params.get("stake") ?? 1000);
  const initialStake = ALLOWED_STAKES.includes(requestedStake) ? requestedStake : 1000;

  const requestedSize = Number(params.get("size") ?? 5) as MinesSize;
  const initialSize: MinesSize = MINES_SIZES.includes(requestedSize) ? requestedSize : 5;

  const [stake, setStake] = useState(initialStake);
  const [size, setSize] = useState<MinesSize>(initialSize);

  if (!ready) return null;

  if (!token) {
    return (
      <main className="lobby">
        <h1 className="lobby-title">Sesión no iniciada</h1>
        <p className="lobby-sub">Necesitas entrar antes de jugar.</p>
        <a className="btn" href="/">
          Ir al lobby
        </a>
      </main>
    );
  }

  // Recien aqui, con el boton pulsado, se monta MinesBoard y arranca la
  // conexion real.
  if (searching) {
    return <MinesBoard key={matchKey} token={token} stake={stake} size={size} onRematch={rematch} />;
  }

  return (
    <main className="lobby">
      <div className="mines-config">
        <h1 className="lobby-title">Minas 1v1</h1>
        <p className="lobby-sub">
          Confirma el tamaño del tablero y la apuesta antes de buscar rival. Nada se envía al
          servidor hasta que pulses "Buscar partida".
        </p>

        <div className="mines-config-picker">
          <h2>Tamaño del tablero</h2>
          <div className="btn-row">
            {MINES_SIZES.map((option) => (
              <button
                key={option}
                type="button"
                className={size === option ? "btn" : "btn btn-ghost"}
                onClick={() => setSize(option)}
              >
                {option}×{option} · {minesFor(option)} minas
              </button>
            ))}
          </div>
        </div>

        <div className="mines-config-picker">
          <h2>Apuesta</h2>
          <div className="btn-row">
            {ALLOWED_STAKES.map((option) => (
              <button
                key={option}
                type="button"
                className={stake === option ? "btn btn-gold" : "btn btn-ghost"}
                onClick={() => setStake(option)}
              >
                {formatCOP(option)}
              </button>
            ))}
          </div>
        </div>

        <div className="mines-config-summary">
          <span className="chip chip-gold">{formatCOP(stake)}</span>
          <span className="chip">pozo {formatCOP(stake * 2)}</span>
          <span className="chip">
            {size}×{size} · {minesFor(size)} minas
          </span>
        </div>

        <button type="button" className="btn-cta" onClick={() => setSearching(true)}>
          <Swords size={20} strokeWidth={2.2} aria-hidden />
          Buscar partida
        </button>

        <a className="btn btn-ghost" href="/">
          Volver al lobby
        </a>
      </div>
    </main>
  );
}

export default function MinesPage() {
  return (
    <Suspense fallback={null}>
      <MinesInner />
    </Suspense>
  );
}
