"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { STAKE_TIERS } from "@ah/shared";
import BlackjackArena from "@/components/BlackjackArena";

/**
 * Va directo a la mesa: la apuesta ya se eligio en el lobby (llega como
 * `?stake=` en la URL). Mismo patron que /mines y /play — sin pantalla de
 * confirmacion intermedia.
 */
function BlackjackInner() {
  const params = useSearchParams();
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
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

  return <BlackjackArena key={matchKey} token={token} stake={stake} onRematch={rematch} />;
}

export default function BlackjackPage() {
  return (
    <Suspense fallback={null}>
      <BlackjackInner />
    </Suspense>
  );
}
