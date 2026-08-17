"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import dynamic from "next/dynamic";
import { AnimatePresence } from "framer-motion";
import { Bomb, Clock3, Gamepad2, Spade, Swords } from "lucide-react";
import {
  BLACKJACK_LIVES,
  GOALS_TO_WIN,
  MINES_LIVES,
  MINES_SIZES,
  MINES_TURN_SECONDS,
  STAKE_TIERS,
  formatCOP,
  minesFor,
  type MinesSize,
} from "@ah/shared";
import { AuthInterceptModal } from "../components/AuthInterceptModal";
import { AuthModal, type AuthSession, type AuthTab } from "../components/AuthModal";
import { CajeroModal, type WalletSnapshot } from "../components/CajeroModal";
import { MatchHistoryModal } from "../components/MatchHistoryModal";
import { TopBar } from "../components/TopBar";
import {
  clearAllSessions,
  readActiveSession,
  saveDevSession,
  saveRealSession,
} from "../lib/authStorage";
import { LiveTicker } from "../components/LiveTicker";
import { StatsWidget, type ActivityStats } from "../components/StatsWidget";
import { GameCard } from "../components/GameCard";
import { BetChips } from "../components/BetChips";
import { AmbientBackground } from "../components/AmbientBackground";
import { FallingChips } from "../components/FallingChips";
import { HeroIntro } from "../components/HeroIntro";

// Cliente-solo: el feed trae "hace Xm" calculado desde Date.now() en una
// constante de modulo. Si esto se renderiza en el servidor, el momento en
// que el servidor evalua el modulo y el momento en que el cliente lo hace
// al hidratar casi nunca coinciden -> el texto no calza y React tira el
// error de hidratacion. No hay nada que SSR aporte a un widget de chat
// puramente interactivo, asi que se desactiva de raiz.
const LiveChatSidebar = dynamic(
  () => import("../components/LiveChatSidebar").then((m) => m.LiveChatSidebar),
  { ssr: false },
);

// `||`, no `??`: ver la nota en next.config.mjs sobre por que un fallback
// con nullish coalescing no protege contra una variable de CI vacia.
const GAME_SERVER_HTTP =
  process.env.NEXT_PUBLIC_GAME_SERVER_HTTP || "http://localhost:2567";

const GAME_META = {
  air_hockey: {
    title: "Air Hockey",
    subtitle: `Reflejos en tiempo real · a ${GOALS_TO_WIN} goles`,
    rules: "Demuestra tus reflejos marcando 7 goles antes que tu rival en tiempo real.",
    icon: Gamepad2,
    accent: "#22e8ff",
    accentGlow: "rgba(34, 232, 255, 0.35)",
  },
  mines: {
    title: "Minas 1v1",
    subtitle: `Azar puro, por turnos · ${MINES_LIVES} vidas`,
    rules: "Juego de estrategia por turnos y azar. Evita destapar las minas para mantener tus 3 vidas.",
    icon: Bomb,
    accent: "#b967ff",
    accentGlow: "rgba(185, 103, 255, 0.35)",
  },
  blackjack: {
    title: "Blackjack Arena",
    subtitle: `Manos 1v1 con revelación final · ${BLACKJACK_LIVES} vidas`,
    rules:
      "Compite mano a mano para acercarte a 21 sin pasarte. El jugador con más vidas gana la partida.",
    icon: Spade,
    accent: "#e11d48",
    accentGlow: "rgba(225, 29, 72, 0.35)",
  },
} as const;

/**
 * Lobby. Entra con un usuario de prueba, muestra el saldo real leido del
 * servidor de juego y lanza el matchmaking.
 *
 * El saldo que se ve aqui es informativo: quien decide si alcanza para apostar
 * es la transaccion de escrow, no esta pantalla. Lo mismo para las metricas de
 * ambiente (jugadores conectados, pozo de hoy, tendencia): salen de
 * /api/activity/*, que lee directo de la base — no hay numeros inventados,
 * salvo el tiempo de espera del matchmaking, que es una cifra ilustrativa
 * porque todavia no se mide.
 */
export default function Lobby() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [name, setName] = useState<string>("");
  const [balance, setBalance] = useState<
    (WalletSnapshot & { locked: number }) | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [game, setGame] = useState<"air_hockey" | "mines" | "blackjack">("air_hockey");
  const [size, setSize] = useState<MinesSize>(5);
  const [stake, setStake] = useState<number>(STAKE_TIERS[0]);
  const [cajeroOpen, setCajeroOpen] = useState(false);
  const [cajeroTab, setCajeroTab] = useState<"deposit" | "withdraw">("deposit");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [activity, setActivity] = useState<ActivityStats | null>(null);
  const [chatOpen, setChatOpen] = useState(true);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  // Modal de cuenta REAL (login/registro con contraseña) — separado del
  // intercept de arriba, que solo avisa que hace falta sesion.
  const [realAuthOpen, setRealAuthOpen] = useState(false);
  const [realAuthTab, setRealAuthTab] = useState<AuthTab>("login");

  // Arranca en `true` tanto en el servidor como en el primer render del
  // cliente (sessionStorage no existe en el servidor) para que hidraten
  // igual; el efecto de abajo la baja a `false` de una si ya se vio esta
  // sesion, apenas monta.
  const [showIntro, setShowIntro] = useState(true);
  useEffect(() => {
    if (sessionStorage.getItem("ah:introSeen")) setShowIntro(false);
  }, []);
  const finishIntro = useCallback(() => {
    sessionStorage.setItem("ah:introSeen", "1");
    setShowIntro(false);
  }, []);

  // En pantallas angostas el chat de 320px se comeria toda la pantalla:
  // arranca colapsado ahi y abierto en escritorio.
  useEffect(() => {
    if (window.innerWidth < 1024) setChatOpen(false);
  }, []);

  useEffect(() => {
    const session = readActiveSession();
    if (session) {
      setToken(session.token);
      setName(session.name);
    }
  }, []);

  const refreshBalance = useCallback(async (jwt: string) => {
    try {
      const response = await fetch(`${GAME_SERVER_HTTP}/api/me/balance`, {
        headers: { authorization: `Bearer ${jwt}` },
      });
      if (!response.ok) throw new Error("no se pudo leer el saldo");
      const data = await response.json();
      setBalance({
        available: data.available,
        locked: data.locked,
        withdrawable: data.withdrawable,
        bonus: data.bonus,
      });
    } catch {
      setError("No se pudo leer el saldo. ¿Está corriendo el game server?");
    }
  }, []);

  useEffect(() => {
    if (token) void refreshBalance(token);
  }, [token, refreshBalance]);

  // Metricas de ambiente del lobby: se comparten entre el panel de stats,
  // las tarjetas de juego (badges) y las fichas de apuesta (rake real).
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${GAME_SERVER_HTTP}/api/activity/stats`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setActivity(data);
      } catch {
        // Ambiente, no critico: se reintenta en la proxima vuelta.
      }
    };
    void load();
    // 30s: suficientemente seguido para que el lobby se sienta vivo, sin
    // convertir cada pestaña abierta en una consulta constante a la base.
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const login = async (user: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      // El emisor de tokens vive en el game-server, no en una API route de
      // Next.js: un export estatico (GitHub Pages) no puede correr codigo de
      // servidor, asi que el unico proceso real que puede firmar un token es
      // el que ya esta corriendo de verdad.
      const response = await fetch(`${GAME_SERVER_HTTP}/api/auth/dev-login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "login fallido");

      saveDevSession({ token: data.token, name: data.displayName });
      setToken(data.token);
      setName(data.displayName);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const logout = (): void => {
    clearAllSessions();
    setToken(null);
    setBalance(null);
  };

  // Cuenta real: AuthModal ya trae el token cuando llama aca, solo hace
  // falta persistirlo y actualizar el mismo estado que ya usa dev-login.
  const onAuthenticated = useCallback((session: AuthSession) => {
    saveRealSession(session);
    setToken(session.token);
    setName(session.name);
  }, []);

  const openRealAuth = useCallback((mode: AuthTab) => {
    setAuthModalOpen(false);
    setRealAuthTab(mode);
    setRealAuthOpen(true);
  }, []);

  // Modo invitado: puede elegir juego y apuesta libremente, pero "Buscar
  // rival ahora" es donde de verdad hace falta sesion — sin cuenta no hay
  // a quien cobrarle ni a quien pagarle el pozo.
  const handleSearchClick = (): void => {
    if (!token) {
      setAuthModalOpen(true);
      return;
    }
    router.push(
      game === "mines"
        ? `/mines?stake=${stake}&size=${size}`
        : game === "blackjack"
          ? `/blackjack?stake=${stake}`
          : `/play?stake=${stake}`,
    );
  };

  const trendingGame = (() => {
    if (!activity) return null;
    const entries = (Object.keys(GAME_META) as Array<keyof typeof GAME_META>).map((key) => ({
      key,
      wins: activity.byGame[key]?.winsToday ?? 0,
    }));
    const max = Math.max(...entries.map((e) => e.wins));
    if (max <= 0) return null;
    const leaders = entries.filter((e) => e.wins === max);
    // Empate entre dos o mas juegos: nadie "tendencia", para no inventar un
    // ganador que no existe.
    return leaders.length === 1 ? leaders[0].key : null;
  })();

  const canAffordStake = !!balance && balance.available >= stake;

  return (
    <>
      <AnimatePresence>{showIntro && <HeroIntro onFinish={finishIntro} />}</AnimatePresence>

      <AmbientBackground leftReserved={chatOpen ? 320 : 0} />
      <FallingChips side="right" leftReserved={chatOpen ? 320 : 0} />
      <FallingChips side="left" leftReserved={chatOpen ? 320 : 0} />
      <LiveChatSidebar
        userName={token ? name : null}
        token={token}
        apiBase={GAME_SERVER_HTTP}
        onlineCount={activity?.online}
        open={chatOpen}
        onOpenChange={setChatOpen}
      />

      <div
        className={`relative min-h-screen z-10 transition-all duration-300 pl-0 ${chatOpen ? "lg:pl-80" : ""}`}
      >
        <div className="app-header">
          <TopBar
            authenticated={!!token}
            name={name}
            balanceFormatted={balance ? formatCOP(balance.available) : null}
            onOpenCajero={() => {
              setCajeroTab("deposit");
              setCajeroOpen(true);
            }}
            onOpenHistory={() => setHistoryOpen(true)}
            onLogout={logout}
            onRequestAuth={openRealAuth}
          />
          <LiveTicker apiBase={GAME_SERVER_HTTP} />
        </div>

        <main className="relative z-10 max-w-6xl mx-auto px-4 py-6">
        <h1 className="hero-title">NEON ARENA</h1>
        <p className="hero-sub">
          Duelos 1v1 por dinero real. El servidor es el único árbitro: tu navegador no simula
          nada, no decide nada y no puede ganar nada mintiendo.
        </p>

        <StatsWidget stats={activity} />

        {error && (
          <div className="card" style={{ borderColor: "rgba(255,93,115,0.45)" }}>
            <p className="note" style={{ color: "var(--danger)" }}>
              {error}
            </p>
          </div>
        )}

        <p className="section-label">Elegir juego</p>
        <div className="game-grid">
          {(Object.keys(GAME_META) as Array<keyof typeof GAME_META>).map((key) => {
            const meta = GAME_META[key];
            const activeMatches = activity?.byGame[key]?.active ?? 0;
            return (
              <GameCard
                key={key}
                title={meta.title}
                subtitle={meta.subtitle}
                rules={meta.rules}
                icon={meta.icon}
                accent={meta.accent}
                accentGlow={meta.accentGlow}
                active={game === key}
                trending={trendingGame === key}
                liveCount={activity ? activeMatches * 2 : null}
                onSelect={() => setGame(key)}
              />
            );
          })}
        </div>

        {game === "mines" && (
          <div className="card">
            <h2>Tamaño del tablero</h2>
            <div className="btn-row">
              {MINES_SIZES.map((option) => {
                const playing = activity?.minesByBoard[option] ?? 0;
                return (
                  <button
                    key={option}
                    className={size === option ? "btn" : "btn btn-ghost"}
                    onClick={() => setSize(option)}
                  >
                    {option}×{option} · {minesFor(option)} minas
                    {activity ? ` · ${playing} jugando` : ""}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <p className="section-label">Elegir apuesta</p>
        <BetChips
          tiers={STAKE_TIERS}
          selected={stake}
          onSelect={setStake}
          rakeBps={activity?.rakeBps ?? 500}
          disabledBelow={balance?.available}
          onlineByStake={
            game === "mines" ? activity?.minesByBoardStake[size] : activity?.byStake[game]
          }
        />

        <div className="cta-wrap">
          <button
            className="cta-button"
            disabled={!!token && !canAffordStake}
            onClick={handleSearchClick}
          >
            <Swords size={20} strokeWidth={2.4} aria-hidden />
            ¡Buscar rival ahora!
          </button>
          <span className="cta-wait">
            <Clock3 size={13} strokeWidth={2.2} aria-hidden />
            Tiempo promedio de espera: ~3 segundos
          </span>
          {token && !canAffordStake && (
            <p className="note" style={{ color: "var(--danger)" }}>
              Saldo insuficiente para esta apuesta.
            </p>
          )}
        </div>

        <p className="note" style={{ marginTop: "1.5rem" }}>
          {game === "mines"
            ? `A ciegas y por turnos: ${MINES_LIVES} vidas, una casilla por turno y ${MINES_TURN_SECONDS} segundos para elegir. Ninguna casilla da pistas de sus vecinas. Cada mina te cuesta una vida; te quedas sin vidas y pierdes. El tablero se fija antes de jugar y puedes verificarlo al terminar.`
            : game === "blackjack"
              ? `${BLACKJACK_LIVES} vidas por partida. Blackjack natural gana la ronda en el acto; si los dos se plantan, se revelan las cartas ocultas y el puntaje menor pierde 1 vida. Empate exacto no cuesta nada.`
              : `Primero en llegar a ${GOALS_TO_WIN} goles. La física corre entera en el servidor.`}
          {" "}Comisión de la casa: 5%. Si te desconectas tienes 15 segundos para volver antes
          de perder por abandono.
        </p>

        {!token && (
          <div className="card">
            <h2>Entrar · usuarios de prueba</h2>

            <label className="terms-check">
              <input
                type="checkbox"
                checked={acceptedTerms}
                onChange={(e) => setAcceptedTerms(e.target.checked)}
              />
              <span>
                He leído, entiendo y acepto los{" "}
                <Link href="/terminos" target="_blank" rel="noopener noreferrer">
                  Términos y Condiciones de Uso
                </Link>{" "}
                y asumo el riesgo de pérdida financiera.
              </span>
            </label>

            <div className="btn-row">
              <button
                className="btn"
                onClick={() => void login("ana")}
                disabled={busy || !acceptedTerms}
              >
                Entrar como Ana
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => void login("beto")}
                disabled={busy || !acceptedTerms}
              >
                Entrar como Beto
              </button>
            </div>
            <p className="note" style={{ marginTop: "1rem" }}>
              Abre las dos sesiones en pestañas separadas para jugar una partida completa.
            </p>
          </div>
        )}
        </main>

        <footer className="site-footer">
          <p className="note">
            Debes ser mayor de edad para usar esta plataforma. Juega con responsabilidad. ·{" "}
            <Link href="/terminos">Términos y Condiciones</Link>
          </p>
        </footer>
      </div>

      <AuthInterceptModal
        open={authModalOpen}
        onClose={() => setAuthModalOpen(false)}
        onCreateAccount={() => openRealAuth("register")}
        onLogin={() => openRealAuth("login")}
      />

      <AuthModal
        open={realAuthOpen}
        onClose={() => setRealAuthOpen(false)}
        initialTab={realAuthTab}
        apiBase={GAME_SERVER_HTTP}
        onAuthenticated={onAuthenticated}
      />

      {token && (
        <>
          <CajeroModal
            open={cajeroOpen}
            onClose={() => setCajeroOpen(false)}
            initialTab={cajeroTab}
            token={token}
            apiBase={GAME_SERVER_HTTP}
            balance={balance}
            onBalanceChange={(fresh) =>
              setBalance((prev) => ({ ...fresh, locked: prev?.locked ?? 0 }))
            }
          />
          <MatchHistoryModal
            open={historyOpen}
            onClose={() => setHistoryOpen(false)}
            token={token}
            apiBase={GAME_SERVER_HTTP}
          />
        </>
      )}
    </>
  );
}
