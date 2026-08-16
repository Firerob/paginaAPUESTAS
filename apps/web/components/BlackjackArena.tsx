"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { Coins, Dices, Heart, Lock, Volume2, VolumeX, Wallet } from "lucide-react";
import {
  BLACKJACK_LIVES,
  BLACKJACK_ROULETTE_COUNTDOWN_MS,
  BLACKJACK_ROULETTE_FADE_MS,
  BLACKJACK_ROULETTE_RESULT_MS,
  BLACKJACK_ROULETTE_SPIN_MS,
  BLACKJACK_SHOWDOWN_MS,
  BLACKJACK_TURN_SECONDS,
  BlackjackClientMessage,
  BlackjackServerMessage,
  ServerMessage,
  cardLabel,
  cardSuitSymbol,
  formatCOP,
  isRedCard,
  type BlackjackBustPayload,
  type BlackjackFairnessPayload,
  type BlackjackNaturalPayload,
  type BlackjackRoulettePayload,
  type BlackjackShowdownPayload,
  type BlackjackState,
  type BlackjackTimeoutPayload,
  type Card,
  type EscrowFailedPayload,
  type JoinedPayload,
  type MatchResultPayload,
  type Seat,
} from "@ah/shared";
import { clearResumeToken, connect, saveResumeToken } from "@/lib/gameSocket";
import { gameAudio } from "@/lib/audio";
import VictoryScreen from "@/components/VictoryScreen";

type Status =
  | { kind: "connecting" }
  | { kind: "queued" }
  | { kind: "playing" }
  | { kind: "reconnecting" }
  | { kind: "error"; message: string }
  | { kind: "finished"; result: MatchResultPayload };

interface Banner {
  id: number;
  text: string;
  tone: "goal" | "win" | "lose" | "neutral";
  sub?: string;
}

interface Props {
  token: string;
  stake: number;
  /** Vuelve a buscar partida con la misma apuesta. Ver el mismo patron en MinesBoard. */
  onRematch: () => void;
}

/**
 * Blackjack Arena 1v1 — a 5 vidas.
 *
 * La mano del rival que se dibuja aca es EXACTAMENTE lo que el servidor
 * decidio mandarle a este cliente: mientras `state.opponentHand[1]` sea
 * `null`, ese valor sencillamente no existe en el payload que llego por la
 * red — no es que este oculto por CSS, es que el servidor nunca lo mando.
 * Ver la nota grande en BlackjackRoom.ts sobre por que la redaccion vive del
 * lado del servidor y no del cliente.
 */
export default function BlackjackArena({ token, stake, onRematch }: Props) {
  const socketRef = useRef<Socket | null>(null);
  const mySeatRef = useRef<Seat>(0);
  const bannerIdRef = useRef(0);
  const turnDeadlineRef = useRef(0);

  const [status, setStatus] = useState<Status>({ kind: "connecting" });
  const [state, setState] = useState<BlackjackState | null>(null);
  const [mySeat, setMySeat] = useState<Seat>(0);
  const [opponentName, setOpponentName] = useState("");
  const [opponentOnline, setOpponentOnline] = useState(true);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [fairness, setFairness] = useState<BlackjackFairnessPayload | null>(null);
  const [muted, setMuted] = useState(false);
  const [shaking, setShaking] = useState(false);
  const [breaking, setBreaking] = useState<Record<number, number>>({});
  const [turnLeft, setTurnLeft] = useState(BLACKJACK_TURN_SECONDS * 1000);
  const [roundsWon, setRoundsWon] = useState(0);
  const [roulette, setRoulette] = useState<{ round: number; startingSeat: Seat } | null>(null);

  const showBanner = useCallback((text: string, tone: Banner["tone"], sub?: string) => {
    setBanner({ id: ++bannerIdRef.current, text, tone, sub });
  }, []);

  const shake = useCallback(() => {
    setShaking(true);
    setTimeout(() => setShaking(false), 400);
  }, []);

  const markBrokenHeart = useCallback((seat: Seat) => {
    setBreaking((current) => ({ ...current, [seat]: (current[seat] ?? 0) + 1 }));
  }, []);

  useEffect(() => setMuted(gameAudio.isMuted), []);

  // -------------------------------------------------------------------------
  // Conexion
  // -------------------------------------------------------------------------
  useEffect(() => {
    const socket = connect(token, { stake, game: "blackjack" });
    socketRef.current = socket;

    socket.on("connect_error", (error: Error) => {
      setStatus({ kind: "error", message: describeError(error.message) });
    });

    socket.on(ServerMessage.QUEUED, () => setStatus({ kind: "queued" }));

    socket.on(ServerMessage.JOINED, (payload: JoinedPayload) => {
      mySeatRef.current = payload.seat;
      setMySeat(payload.seat);
      setOpponentName(payload.opponentName);
      saveResumeToken(payload.resumeToken);
      setStatus({ kind: "playing" });
      gameAudio.play("start");
    });

    socket.on(BlackjackServerMessage.STATE, (next: BlackjackState) => {
      setState(next);
      turnDeadlineRef.current = performance.now() + next.turnMs;
      setTurnLeft(next.turnMs);
      // En cuanto llegan cartas, la ruleta ya cumplio su parte: se retira
      // para dejarle la mesa al reparto.
      if (next.myHand.length > 0) setRoulette(null);
    });

    socket.on(BlackjackServerMessage.ROULETTE, (payload: BlackjackRoulettePayload) => {
      setRoulette({ round: payload.round, startingSeat: payload.startingSeat });
      gameAudio.play("countdown");
    });

    socket.on(BlackjackServerMessage.NATURAL, (payload: BlackjackNaturalPayload) => {
      const mineBj = payload.seat0Blackjack === (mySeatRef.current === 0) || payload.seat1Blackjack === (mySeatRef.current === 1);
      const tie = payload.loserSeat === null;
      if (tie) {
        showBanner("¡BLACKJACK DOBLE!", "neutral", "Empate — nadie pierde vida");
      } else {
        const won = payload.loserSeat !== mySeatRef.current;
        if (won) markBrokenHeart(payload.loserSeat!);
        gameAudio.play(won ? "goal" : "defeat");
        showBanner(
          won ? "¡BLACKJACK!" : "TU RIVAL SACÓ BLACKJACK",
          won ? "goal" : "lose",
          won ? "El rival pierde 1 vida" : "Pierdes 1 vida",
        );
        shake();
      }
      void mineBj;
    });

    socket.on(BlackjackServerMessage.BUST, (payload: BlackjackBustPayload) => {
      const mine = payload.seat === mySeatRef.current;
      markBrokenHeart(payload.seat);
      gameAudio.play(mine ? "defeat" : "goal");
      shake();
      showBanner(
        mine ? "¡TE PASASTE!" : "¡TU RIVAL SE PASÓ!",
        mine ? "lose" : "goal",
        `${payload.total} puntos`,
      );
      if (!mine) setRoundsWon((n) => n + 1);
    });

    socket.on(BlackjackServerMessage.SHOWDOWN, (payload: BlackjackShowdownPayload) => {
      const [t0, t1] = payload.totals;
      const myTotal = mySeatRef.current === 0 ? t0 : t1;
      const rivalTotal = mySeatRef.current === 0 ? t1 : t0;
      const tie = payload.loserSeat === null;

      if (tie) {
        showBanner("EMPATE", "neutral", `TÚ: ${myTotal} PTS · RIVAL: ${rivalTotal} PTS`);
      } else {
        const won = payload.loserSeat !== mySeatRef.current;
        if (won) {
          markBrokenHeart(payload.loserSeat!);
          setRoundsWon((n) => n + 1);
        }
        gameAudio.play(won ? "goal" : "defeat");
        showBanner(
          won ? "GANAS LA RONDA" : "PIERDES LA RONDA",
          won ? "goal" : "lose",
          `TÚ: ${myTotal} PTS vs RIVAL: ${rivalTotal} PTS`,
        );
      }
    });

    socket.on(BlackjackServerMessage.TIMEOUT, (payload: BlackjackTimeoutPayload) => {
      const mine = payload.seat === mySeatRef.current;
      markBrokenHeart(payload.seat);
      gameAudio.play(mine ? "defeat" : "goal");
      shake();
      showBanner(
        mine ? "¡SE TE ACABÓ EL TIEMPO!" : "¡AL RIVAL SE LE ACABÓ EL TIEMPO!",
        mine ? "lose" : "goal",
        "Pierde la ronda quien no juega a tiempo",
      );
      if (!mine) setRoundsWon((n) => n + 1);
    });

    socket.on(BlackjackServerMessage.REJECTED, (payload: { reason: string }) => {
      const messages: Record<string, string> = {
        not_your_turn: "No es tu turno",
        not_playing: "La ronda no está en juego",
        rate_limited: "Demasiado rápido",
      };
      showBanner(messages[payload.reason] ?? "Jugada inválida", "neutral");
    });

    socket.on(BlackjackServerMessage.FAIRNESS, (payload: BlackjackFairnessPayload) => {
      setFairness(payload);
    });

    socket.on(ServerMessage.MATCH_RESULT, (result: MatchResultPayload) => {
      clearResumeToken();
      setStatus({ kind: "finished", result });
      if (result.payout === null) {
        showBanner("EMPATE", "neutral", "Se devolvió tu apuesta");
      } else if (result.youWon) {
        showBanner("¡VICTORIA!", "win", `+${formatCOP(result.payout)}`);
        gameAudio.play("victory");
      } else {
        showBanner("DERROTA", "lose", `-${formatCOP(stake)}`);
        gameAudio.play("defeat");
      }
    });

    socket.on(ServerMessage.ESCROW_FAILED, (payload: EscrowFailedPayload) => {
      clearResumeToken();
      setStatus({ kind: "error", message: describeError(payload.reason, payload.isYou) });
    });

    socket.on(ServerMessage.OPPONENT, (payload: { connected: boolean }) => {
      setOpponentOnline(payload.connected);
    });

    socket.io.on("reconnect_attempt", () => {
      setStatus((current) => (current.kind === "finished" ? current : { kind: "reconnecting" }));
    });
    socket.io.on("reconnect", () => setStatus({ kind: "playing" }));
    socket.io.on("reconnect_failed", () =>
      setStatus({ kind: "error", message: "No se pudo restablecer la conexión." }),
    );

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [token, stake, showBanner, shake, markBrokenHeart]);

  // -------------------------------------------------------------------------
  // Red de seguridad: revelado colgado (MATCH_RESULT que nunca llego)
  // -------------------------------------------------------------------------
  // El servidor ya sincroniza phase="finished" apenas alguien se queda sin
  // vidas (ver BlackjackRoom.finishByLives), asi que en el camino normal
  // este timer nunca llega a disparar: el HUD sale de "showdown" antes.
  // Sigue existiendo por si la liquidacion falla del lado del servidor (o el
  // evento se pierde en la red) y el jugador queda mirando "REVELANDO
  // CARTAS..." sin ningun mensaje — eso es peor que un error explicito con
  // boton para volver.
  useEffect(() => {
    if (state?.phase !== "showdown") return;

    const timer = setTimeout(() => {
      setStatus((current) =>
        current.kind === "playing"
          ? {
              kind: "error",
              message: "No pudimos confirmar el resultado. Tu saldo está protegido — revísalo en el lobby.",
            }
          : current,
      );
    }, BLACKJACK_SHOWDOWN_MS + 4000);

    return () => clearTimeout(timer);
  }, [state?.phase, state?.round]);

  // -------------------------------------------------------------------------
  // Reloj del turno
  // -------------------------------------------------------------------------
  useEffect(() => {
    let frame = 0;
    const loop = (now: number): void => {
      frame = requestAnimationFrame(loop);
      setTurnLeft(Math.max(0, turnDeadlineRef.current - now));
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, []);

  // -------------------------------------------------------------------------
  // Jugadas
  // -------------------------------------------------------------------------
  const myTurn =
    state?.phase === "playing" && state.currentTurnSeat === mySeat && !state.myStood && opponentOnline;

  const hit = useCallback(() => {
    gameAudio.unlock();
    if (!myTurn) return;
    gameAudio.play("hit", 0.45);
    socketRef.current?.emit(BlackjackClientMessage.HIT);
  }, [myTurn]);

  const stand = useCallback(() => {
    gameAudio.unlock();
    if (!myTurn) return;
    socketRef.current?.emit(BlackjackClientMessage.STAND);
  }, [myTurn]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  const myLives = state?.lives[mySeat] ?? BLACKJACK_LIVES;
  const rivalSeat: Seat = mySeat === 0 ? 1 : 0;
  const rivalLives = state?.lives[rivalSeat] ?? BLACKJACK_LIVES;
  const seconds = Math.ceil(turnLeft / 1000);
  const turnPct = Math.max(0, Math.min(100, (turnLeft / (BLACKJACK_TURN_SECONDS * 1000)) * 100));
  const urgent = myTurn && seconds <= 3;
  const showdownActive = state?.phase === "showdown";
  const roundOver = showdownActive || state?.phase === "finished";

  return (
    <div className={`game-shell bj-arena ${shaking ? "shake" : ""}`} onPointerDown={() => gameAudio.unlock()}>
      {roulette && (
        <RouletteOverlay
          round={roulette.round}
          startingSeat={roulette.startingSeat}
          mySeat={mySeat}
          opponentName={opponentName}
        />
      )}

      <header className="hud">
        <div className="hud-side">
          <span className="chip chip-gold">{formatCOP(stake)}</span>
          <span className="chip">pozo {formatCOP(stake * 2)}</span>
          <span className="chip">ronda {state?.round ?? 1}</span>
        </div>

        <div className="lives-board">
          <Lives label="TÚ" lives={myLives} tone="self" bump={breaking[mySeat] ?? 0} />
          <span className="lives-vs">VS</span>
          <Lives
            label={opponentName || "RIVAL"}
            lives={rivalLives}
            tone="rival"
            bump={breaking[rivalSeat] ?? 0}
          />
        </div>

        <div className="hud-side hud-side-end">
          {state?.commit && (
            <span className="chip chip-mono" title={`Compromiso de la baraja: ${state.commit}`}>
              <Lock size={12} strokeWidth={2.4} aria-hidden />
              {state.commit.slice(0, 8)}
            </span>
          )}
          <button
            type="button"
            className="chip chip-button"
            onClick={() => {
              gameAudio.unlock();
              setMuted(gameAudio.toggleMute());
            }}
            aria-label={muted ? "Activar sonido" : "Silenciar"}
          >
            {muted ? (
              <VolumeX size={16} strokeWidth={2.2} aria-hidden />
            ) : (
              <Volume2 size={16} strokeWidth={2.2} aria-hidden />
            )}
          </button>
        </div>
      </header>

      <div className="stage bj-stage">
        <div className="mines-turn">
          <div
            className={`turn-banner ${myTurn ? "turn-mine" : "turn-rival"}`}
            role="status"
            aria-live="polite"
          >
            {state?.phase === "finished"
              ? "PARTIDA TERMINADA"
              : showdownActive
                ? "REVELANDO CARTAS…"
                : myTurn
                  ? "TU TURNO"
                  : `TURNO DE ${(opponentName || "TU RIVAL").toUpperCase()}`}
          </div>

          {!roundOver && (
            <div className={`turn-clock ${urgent ? "turn-clock-urgent" : ""}`}>
              <span className="turn-seconds">{seconds}</span>
              <div className="turn-bar" aria-hidden>
                <div
                  className={`turn-bar-fill ${turnPct < 30 ? "turn-bar-low" : ""}`}
                  style={{ width: `${turnPct}%` }}
                />
              </div>
            </div>
          )}
        </div>

        <div className="bj-table">
          <HandRow
            label={opponentName || "RIVAL"}
            cards={state?.opponentHand ?? []}
            total={state?.opponentTotal ?? 0}
            revealed={showdownActive || state?.phase === "finished"}
            busted={state?.opponentBusted ?? false}
            stood={state?.opponentStood ?? false}
            tone="rival"
            highlight={showdownActive}
          />

          <div className="bj-divider">
            <Dices size={16} strokeWidth={2.2} aria-hidden />
          </div>

          <HandRow
            label="TÚ"
            cards={state?.myHand ?? []}
            total={state?.myTotal ?? 0}
            revealed
            busted={state?.myBusted ?? false}
            stood={state?.myStood ?? false}
            tone="self"
            highlight={showdownActive}
          />
        </div>

        <div className="bj-actions">
          <button type="button" className="btn btn-gold" onClick={hit} disabled={!myTurn}>
            Pedir carta
          </button>
          <button type="button" className="btn btn-ghost" onClick={stand} disabled={!myTurn}>
            Plantarse
          </button>
        </div>

        <p className="note mines-hint">
          El As vale 11 u 1 automáticamente. Blackjack natural con las dos primeras cartas gana la
          ronda en el acto.
        </p>

        {banner && (
          <div key={banner.id} className={`banner banner-${banner.tone}`}>
            <span className="banner-text">{banner.text}</span>
            {banner.sub && <span className="banner-sub">{banner.sub}</span>}
          </div>
        )}

        {!opponentOnline && status.kind === "playing" && (
          <div className="alert">
            <strong>Rival desconectado</strong>
            <span>El reloj está congelado. Si no vuelve, ganas.</span>
          </div>
        )}

        <BlackjackPanel
          status={status}
          stake={stake}
          mySeat={mySeat}
          roundsWon={roundsWon}
          onRematch={onRematch}
        />
      </div>
    </div>
  );
}

type RoulettePhase = "counting" | "spinning" | "result" | "closing";

/**
 * Overlay a pantalla completa del sorteo INICIAL de la partida (solo pasa
 * una vez, en la ronda 1 — ver `BlackjackRoom.startRound`). Tapa toda la
 * mesa (`fixed inset-0`, fondo casi opaco + blur) hasta que se sabe quien
 * arranca: una moneda 3D gigante con cara TÚ (cyan) y cara RIVAL (magenta)
 * gira sobre su eje y frena mostrando la cara ganadora, que ya decidio el
 * servidor (`startingSeat` llega ya resuelto al montar este componente —
 * esto es la puesta en escena, no el sorteo en si, que ya salio
 * determinista de la semilla de la partida). Los dos jugadores reciben el
 * mismo evento ROULETTE al mismo tiempo y corren la misma animacion con los
 * mismos tiempos, asi que ven la misma moneda parar en el mismo resultado a
 * la vez — no es cosmetica de un solo lado.
 *
 * Fases: cuenta regresiva -> giro -> resultado quieto -> fade out. La suma
 * de las cuatro (`BLACKJACK_ROULETTE_MS`) es exactamente cuanto espera el
 * servidor antes de repartir, asi que el overlay siempre termina de
 * desvanecerse justo cuando las cartas ya estan listas debajo.
 */
function RouletteOverlay({
  round,
  startingSeat,
  mySeat,
  opponentName,
}: {
  round: number;
  startingSeat: Seat;
  mySeat: Seat;
  opponentName: string;
}) {
  const [phase, setPhase] = useState<RoulettePhase>("counting");
  const [countLeft, setCountLeft] = useState(Math.ceil(BLACKJACK_ROULETTE_COUNTDOWN_MS / 1000));

  useEffect(() => {
    setPhase("counting");
    const startedAt = performance.now();
    setCountLeft(Math.ceil(BLACKJACK_ROULETTE_COUNTDOWN_MS / 1000));

    const tick = setInterval(() => {
      const left = BLACKJACK_ROULETTE_COUNTDOWN_MS - (performance.now() - startedAt);
      setCountLeft(Math.max(1, Math.ceil(left / 1000)));
    }, 200);

    const spinTimer = setTimeout(() => {
      clearInterval(tick);
      setPhase("spinning");
    }, BLACKJACK_ROULETTE_COUNTDOWN_MS);

    const resultTimer = setTimeout(
      () => setPhase("result"),
      BLACKJACK_ROULETTE_COUNTDOWN_MS + BLACKJACK_ROULETTE_SPIN_MS,
    );

    const closeTimer = setTimeout(
      () => setPhase("closing"),
      BLACKJACK_ROULETTE_COUNTDOWN_MS + BLACKJACK_ROULETTE_SPIN_MS + BLACKJACK_ROULETTE_RESULT_MS,
    );

    return () => {
      clearInterval(tick);
      clearTimeout(spinTimer);
      clearTimeout(resultTimer);
      clearTimeout(closeTimer);
    };
  }, [round]);

  const mine = startingSeat === mySeat;
  const rivalLabel = (opponentName || "TU RIVAL").toUpperCase();
  const winnerName = mine ? "TÚ" : rivalLabel;

  // La cara frontal (0deg) siempre es "TÚ" y la trasera (180deg) siempre es
  // "RIVAL" — fijo por jugador, no depende del resultado. Para aterrizar en
  // la cara correcta basta con dar un numero entero de vueltas completas (mi
  // cara gana) o esas vueltas + media (gana la cara del rival). El numero de
  // vueltas y el pequeño temblor son puramente cosmeticos: el resultado real
  // ya lo decidio el servidor antes de que este componente exista.
  const rotationY = useMemo(() => {
    const flips = 5 + Math.floor(Math.random() * 3);
    const jitter = (Math.random() - 0.5) * 10;
    return flips * 360 + (mine ? 0 : 180) + jitter;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round, mine]);

  const spinning = phase === "spinning" || phase === "result" || phase === "closing";

  return (
    <div
      className={`bj-roulette-overlay ${phase === "closing" ? "bj-roulette-overlay-closing" : ""}`}
      style={{ transitionDuration: `${BLACKJACK_ROULETTE_FADE_MS}ms` }}
    >
      <p
        className={`bj-roulette-title ${phase === "result" || phase === "closing" ? "bj-roulette-title-result" : ""}`}
      >
        {phase === "result" || phase === "closing" ? `¡${winnerName} INICIA EL TURNO!` : "SELECCIONANDO QUIÉN COMIENZA…"}
      </p>

      <div className="bj-roulette-coin-scene">
        {(phase === "result" || phase === "closing") && <div key={round} className="bj-roulette-flash" aria-hidden />}

        <div className="bj-roulette-pointer" aria-hidden />

        <div className="bj-roulette-coin-rim">
          <div
            className={`bj-roulette-coin ${spinning ? "bj-roulette-coin-spin" : ""}`}
            style={{ transform: `rotateY(${spinning ? rotationY : 0}deg)` }}
          >
            <div
              className={`bj-roulette-coin-face bj-roulette-coin-face-self ${phase === "counting" ? "bj-roulette-coin-face-blank" : ""}`}
            >
              <Dices size={40} strokeWidth={2} aria-hidden />
              <span>TÚ</span>
            </div>
            <div
              className={`bj-roulette-coin-face bj-roulette-coin-face-rival ${phase === "counting" ? "bj-roulette-coin-face-blank" : ""}`}
            >
              <Dices size={40} strokeWidth={2} aria-hidden />
              <span>{rivalLabel.slice(0, 10)}</span>
            </div>
          </div>
        </div>

        {phase === "counting" && (
          <div className="bj-roulette-countdown" key={countLeft} role="status" aria-live="polite">
            {countLeft}
          </div>
        )}
      </div>
    </div>
  );
}

/** Fila de corazones de un jugador. Mismo patron visual que Minas. */
function Lives({
  label,
  lives,
  tone,
  bump,
}: {
  label: string;
  lives: number;
  tone: "self" | "rival";
  bump: number;
}) {
  return (
    <div className={`lives lives-${tone}`}>
      <span className="lives-name">{label}</span>
      <span className="lives-hearts" aria-label={`${lives} de ${BLACKJACK_LIVES} vidas`}>
        {Array.from({ length: BLACKJACK_LIVES }, (_, i) => {
          const alive = i < lives;
          return (
            <span
              key={`${i}-${alive ? "on" : `off-${bump}`}`}
              className={`heart ${alive ? "heart-on" : "heart-off"}`}
              aria-hidden
            >
              <Heart size={16} strokeWidth={2.2} fill={alive ? "currentColor" : "none"} />
            </span>
          );
        })}
      </span>
    </div>
  );
}

/** Una carta boca arriba, o el reverso si `card` es null. */
function PlayingCard({ card, dim }: { card: Card | null; dim?: boolean }) {
  if (card === null) {
    return (
      <div className="bj-card bj-card-back" aria-label="carta boca abajo">
        <span className="bj-card-back-glyph" aria-hidden>
          ♠
        </span>
      </div>
    );
  }
  const red = isRedCard(card);
  return (
    <div className={`bj-card ${red ? "bj-card-red" : "bj-card-black"} ${dim ? "bj-card-dim" : ""}`}>
      <span className="bj-card-rank">{cardLabel(card)}</span>
      <span className="bj-card-suit" aria-hidden>
        {cardSuitSymbol(card)}
      </span>
    </div>
  );
}

function HandRow({
  label,
  cards,
  total,
  revealed,
  busted,
  stood,
  tone,
  highlight,
}: {
  label: string;
  cards: (Card | null)[];
  total: number;
  revealed: boolean;
  busted: boolean;
  stood: boolean;
  tone: "self" | "rival";
  highlight: boolean;
}) {
  return (
    <div className={`bj-hand bj-hand-${tone}`}>
      <div className="bj-hand-header">
        <span className="bj-hand-label">{label}</span>
        <span
          className={`bj-total-badge ${busted ? "bj-total-bust" : ""} ${highlight ? "bj-total-glow" : ""}`}
        >
          {total} PTS
        </span>
        {stood && !busted && <span className="chip chip-mono">plantado</span>}
        {busted && <span className="chip chip-warn">se pasó</span>}
      </div>
      <div className="bj-cards">
        {cards.length === 0 ? (
          <p className="note">Repartiendo…</p>
        ) : (
          cards.map((card, i) => <PlayingCard key={i} card={revealed ? (card ?? null) : card} />)
        )}
      </div>
    </div>
  );
}

function BlackjackPanel({
  status,
  stake,
  mySeat,
  roundsWon,
  onRematch,
}: {
  status: Status;
  stake: number;
  mySeat: Seat;
  roundsWon: number;
  onRematch: () => void;
}) {
  if (status.kind === "playing") return null;

  if (status.kind === "finished") {
    const { result } = status;
    const voided = result.payout === null;

    if (!voided && result.youWon) {
      return (
        <VictoryScreen
          payout={result.payout ?? 0}
          rake={result.rake ?? 0}
          balanceAfter={result.balanceAfter}
          onRematch={onRematch}
          stats={[
            {
              icon: <Heart size={18} strokeWidth={2.2} fill="currentColor" />,
              label: "Vidas restantes",
              value: `${result.scores[mySeat]} / ${BLACKJACK_LIVES}`,
            },
            {
              icon: <Coins size={18} strokeWidth={2.2} />,
              label: "Rondas ganadas",
              value: String(roundsWon),
            },
            {
              icon: <Wallet size={18} strokeWidth={2.2} />,
              label: "Apuesta inicial",
              value: formatCOP(stake),
            },
          ]}
        />
      );
    }

    return (
      <div className="panel">
        <div className="panel-card">
          <h2 className={voided ? "" : "title-lose"}>{voided ? "Empate" : "Perdiste"}</h2>
          <p className="panel-line muted">Vidas restantes</p>
          <p className="panel-score">
            {result.scores[0]} — {result.scores[1]}
          </p>
          {voided ? (
            <p className="panel-line">Se devolvió tu apuesta de {formatCOP(stake)} completa.</p>
          ) : (
            <p className="panel-prize panel-prize-lose">-{formatCOP(stake)}</p>
          )}
          <p className="panel-line muted">Saldo: {formatCOP(result.balanceAfter)}</p>

          <a className="btn" href="/">
            Volver al lobby
          </a>
        </div>
      </div>
    );
  }

  const messages: Record<string, string> = {
    connecting: "Conectando…",
    queued: "Buscando rival…",
    reconnecting: "Reconectando… tu apuesta sigue bloqueada.",
  };

  return (
    <div className="panel">
      <div className="panel-card">
        {status.kind !== "error" && <div className="spinner" aria-hidden />}
        <p className="panel-line">
          {status.kind === "error" ? status.message : messages[status.kind]}
        </p>
        {status.kind === "error" && (
          <a className="btn" href="/">
            Volver
          </a>
        )}
      </div>
    </div>
  );
}

function describeError(reason: string, isYou = true): string {
  if (reason.includes("insufficient_funds")) {
    return isYou
      ? "No tienes saldo suficiente para esta apuesta."
      : "Tu rival no tenía saldo. No se te cobró nada.";
  }
  if (reason.includes("already_in_match")) return "Ya tienes una partida abierta.";
  if (reason.includes("invalid_stake")) return "Monto de apuesta no permitido.";
  if (reason.includes("resume_expired")) return "La partida ya terminó.";
  if (reason.includes("expired_token")) return "Tu sesión expiró. Vuelve a entrar.";
  if (reason.includes("user_blocked")) return "Tu cuenta no puede apostar en este momento.";
  return "No se pudo iniciar la partida. No se cobró nada.";
}
