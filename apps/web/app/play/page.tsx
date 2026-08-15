"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import GameCanvas from "@/components/GameCanvas";

const ALLOWED_STAKES = [1000, 5000, 10000];

function PlayInner() {
  const params = useSearchParams();
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  // Cambiar la key fuerza un remount completo de GameCanvas: es la forma mas
  // simple de repetir el flujo de conexion (nueva partida, mismo monto) sin
  // duplicar la logica de "reconectar sin desmontar".
  const [matchKey, setMatchKey] = useState(0);
  const rematch = useCallback(() => setMatchKey((key) => key + 1), []);

  useEffect(() => {
    setToken(sessionStorage.getItem("ah:token"));
    setReady(true);
  }, []);

  const requested = Number(params.get("stake") ?? 1000);
  const stake = ALLOWED_STAKES.includes(requested) ? requested : 1000;

  if (!ready) return null;

  if (!token) {
    return (
      <main className="lobby">
        <h1>Sesion no iniciada</h1>
        <p className="sub">Necesitas entrar antes de jugar.</p>
        <a className="btn" href="/">
          Ir al lobby
        </a>
      </main>
    );
  }

  return <GameCanvas key={matchKey} token={token} stake={stake} onRematch={rematch} />;
}

export default function PlayPage() {
  return (
    <Suspense fallback={null}>
      <PlayInner />
    </Suspense>
  );
}
