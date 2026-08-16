"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { MINES_SIZES, STAKE_TIERS, type MinesSize } from "@ah/shared";
import MinesBoard from "@/components/MinesBoard";

/**
 * Va directo al tablero: la eleccion de apuesta y tamaño ya se hizo en el
 * lobby (llega como `?stake=&size=` en la URL). Esta pantalla ya no vuelve
 * a preguntar nada — su unico trabajo es validar sesion y lanzar la
 * conexion real. El servidor vuelve a validar `stake`/`size` contra su
 * propia lista antes de cobrar nada, asi que esto es solo para no mandar
 * un valor absurdo en el primer mensaje.
 */
function MinesInner() {
  const params = useSearchParams();
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  // Cambiar la key fuerza un remount completo de MinesBoard: repite el
  // mismo flujo de conexion probado (nueva partida, mismos parametros).
  const [matchKey, setMatchKey] = useState(0);
  const rematch = useCallback(() => setMatchKey((key) => key + 1), []);

  useEffect(() => {
    setToken(sessionStorage.getItem("ah:token"));
    setReady(true);
  }, []);

  const requestedStake = Number(params.get("stake") ?? STAKE_TIERS[0]);
  const stake = (STAKE_TIERS as readonly number[]).includes(requestedStake)
    ? requestedStake
    : STAKE_TIERS[0];

  const requestedSize = Number(params.get("size") ?? 5) as MinesSize;
  const size: MinesSize = MINES_SIZES.includes(requestedSize) ? requestedSize : 5;

  if (!ready) return null;

  if (!token) {
    return (
      <main className="lobby">
        <h1 className="lobby-title">Sesión no iniciada</h1>
        <p className="lobby-sub">Necesitas entrar antes de jugar.</p>
        <Link className="btn" href="/">
          Ir al lobby
        </Link>
      </main>
    );
  }

  return <MinesBoard key={matchKey} token={token} stake={stake} size={size} onRematch={rematch} />;
}

export default function MinesPage() {
  return (
    <Suspense fallback={null}>
      <MinesInner />
    </Suspense>
  );
}
