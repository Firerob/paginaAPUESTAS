"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { Gem, Heart, Lock, Skull, Volume2, VolumeX, Wallet } from "lucide-react";
import {
  MINES_LIVES,
  MINES_MAX_TIMEOUTS,
  MINES_TURN_SECONDS,
  MinesClientMessage,
  MinesServerMessage,
  ServerMessage,
  TILE_HIDDEN,
  TILE_MINE,
  formatCOP,
  type EscrowFailedPayload,
  type JoinedPayload,
  type MatchResultPayload,
  type MinesFairnessPayload,
  type MinesRevealPayload,
  type MinesSize,
  type MinesState,
  type MinesTimeoutPayload,
  type Seat,
} from "@ah/shared";
import { clearResumeToken, connect, saveResumeToken } from "@/lib/gameSocket";
import { ParticleSystem } from "@/lib/particles";
import { gameAudio } from "@/lib/audio";
import { NEON } from "@/lib/theme";
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
  size: MinesSize;
  /**
   * Vuelve a buscar partida con la misma apuesta y tamaño. La implementa la
   * pagina contenedora forzando un remount (cambio de `key`) de este
   * componente: repite el mismo flujo de conexion ya probado en vez de
   * inventar un segundo camino de "reconectar sin desmontar".
   */
  onRematch: () => void;
}

/**
 * Minas 1v1 — juego a ciegas.
 *
 * El tablero que se dibuja aqui es SOLO lo que el servidor ha revelado: las
 * casillas ocultas llegan como TILE_HIDDEN y no hay ningun otro dato del que
 * deducir donde estan las minas. Abrir DevTools, parchear este archivo o leer
 * el trafico no sirve de nada, porque la informacion no esta en el cliente.
 *
 * No se muestran numeros de minas adyacentes: destapar una casilla no dice
 * nada de sus vecinas. Cada eleccion es una apuesta a ciegas.
 *
 * Las casillas son elementos del DOM (mejor accesibilidad y animacion con
 * CSS) y encima va un canvas transparente solo para las particulas.
 */
export default function MinesBoard({ token, stake, size, onRematch }: Props) {
  const socketRef = useRef<Socket | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const particlesRef = useRef(new ParticleSystem());
  const mySeatRef = useRef<Seat>(0);
  const bannerIdRef = useRef(0);
  /** Casillas recien destapadas, para animarlas una sola vez. */
  const freshRef = useRef(new Set<number>());
  const lastTickRef = useRef(-1);
  /**
   * Casillas seguras que destapo YO, contadas en vivo desde el evento SAFE.
   *
   * No se puede leer de `state.revealedTiles` al terminar: en la jugada que
   * cierra la partida (mina o tablero despejado) el servidor no vuelve a
   * emitir STATE antes de liquidar, asi que la ultima instantanea puede
   * quedar un movimiento atras. El evento SAFE, en cambio, se emite siempre
   * en el momento exacto del destape — es la fuente que nunca se atrasa.
   */
  const safeRevealedRef = useRef(0);

  const [status, setStatus] = useState<Status>({ kind: "connecting" });
  const [state, setState] = useState<MinesState | null>(null);
  const [mySeat, setMySeat] = useState<Seat>(0);
  const [opponentName, setOpponentName] = useState("");
  const [opponentOnline, setOpponentOnline] = useState(true);
  const [banner, setBanner] = useState<Banner | null>(null);
  // Se sigue guardando: alimenta `revealedMines` mas abajo, que muestra en
  // el tablero las minas que nunca se pisaron cuando termina la partida.
  // La tarjeta "Juego limpio verificable" que mostraba la semilla y el hash
  // se quito de la interfaz, pero el commit-reveal sigue corriendo en el
  // servidor (columnas `commit_hash`/`revealed_at`, ver SECURITY.md).
  const [fairness, setFairness] = useState<MinesFairnessPayload | null>(null);
  const [muted, setMuted] = useState(false);
  const [shaking, setShaking] = useState(false);
  /** Corazones que acaban de romperse, para animarlos. */
  const [breaking, setBreaking] = useState<Record<number, number>>({});
  /** Reloj local del turno; el servidor manda el limite y aqui se cuenta. */
  const [turnLeft, setTurnLeft] = useState(MINES_TURN_SECONDS * 1000);
  const turnDeadlineRef = useRef(0);

  const showBanner = useCallback((text: string, tone: Banner["tone"], sub?: string) => {
    setBanner({ id: ++bannerIdRef.current, text, tone, sub });
  }, []);

  useEffect(() => setMuted(gameAudio.isMuted), []);

  /** Centro de una casilla, en pixeles relativos al canvas de efectos. */
  const cellCenter = useCallback((index: number): { x: number; y: number } | null => {
    const grid = gridRef.current;
    const canvas = canvasRef.current;
    if (!grid || !canvas) return null;
    const cell = grid.children[index] as HTMLElement | undefined;
    if (!cell) return null;

    const cellRect = cell.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    return {
      x: cellRect.left - canvasRect.left + cellRect.width / 2,
      y: cellRect.top - canvasRect.top + cellRect.height / 2,
    };
  }, []);

  /** Sacudida de pantalla. Se corta sola. */
  const shake = useCallback(() => {
    setShaking(true);
    setTimeout(() => setShaking(false), 500);
  }, []);

  const markBrokenHeart = useCallback((seat: Seat) => {
    setBreaking((current) => ({ ...current, [seat]: (current[seat] ?? 0) + 1 }));
  }, []);

  // -------------------------------------------------------------------------
  // Conexion
  // -------------------------------------------------------------------------
  useEffect(() => {
    const socket = connect(token, { stake, game: "mines", size });
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

    socket.on(MinesServerMessage.STATE, (next: MinesState) => {
      setState(next);
      // El servidor manda cuanto queda; el conteo fino lo lleva el cliente
      // para no gastar un mensaje por segundo. Quien decide de verdad si el
      // turno expiro sigue siendo el servidor.
      turnDeadlineRef.current = performance.now() + next.turnMs;
      setTurnLeft(next.turnMs);
    });

    socket.on(MinesServerMessage.SAFE, (payload: MinesRevealPayload) => {
      freshRef.current.add(payload.index);
      if (payload.seat === mySeatRef.current) safeRevealedRef.current += 1;
      gameAudio.play("hit", 0.45);
      const center = cellCenter(payload.index);
      if (center) {
        particlesRef.current.malletHit(
          center.x,
          center.y,
          payload.seat === mySeatRef.current ? NEON.self : NEON.cyan,
          0.4,
        );
      }
    });

    socket.on(MinesServerMessage.EXPLODED, (payload: MinesRevealPayload) => {
      freshRef.current.add(payload.index);
      gameAudio.play("goal");
      shake();
      markBrokenHeart(payload.seat);

      const center = cellCenter(payload.index);
      if (center) particlesRef.current.goalBurst(center.x, center.y, NEON.rival);

      const mine = payload.seat === mySeatRef.current;
      showBanner(
        mine ? "¡BOOM!" : "¡EXPLOTÓ!",
        mine ? "lose" : "goal",
        mine
          ? `Te queda${payload.livesLeft === 1 ? "" : "n"} ${payload.livesLeft} vida${payload.livesLeft === 1 ? "" : "s"}`
          : `A tu rival le queda${payload.livesLeft === 1 ? "" : "n"} ${payload.livesLeft}`,
      );
    });

    socket.on(MinesServerMessage.TIMEOUT, (payload: MinesTimeoutPayload) => {
      markBrokenHeart(payload.seat);
      gameAudio.play("defeat");
      const mine = payload.seat === mySeatRef.current;
      showBanner(
        mine ? "SE TE ACABÓ EL TIEMPO" : "AL RIVAL SE LE ACABÓ EL TIEMPO",
        mine ? "lose" : "neutral",
        payload.strikes >= MINES_MAX_TIMEOUTS - 1 && mine
          ? "Otra ausencia y pierdes por abandono"
          : `−1 vida · quedan ${payload.livesLeft}`,
      );
    });

    socket.on(MinesServerMessage.REJECTED, (payload: { reason: string }) => {
      const messages: Record<string, string> = {
        not_your_turn: "No es tu turno",
        already_revealed: "Esa casilla ya está destapada",
        rate_limited: "Demasiado rápido",
        out_of_range: "Casilla inválida",
        not_playing: "La partida no está en juego",
      };
      showBanner(messages[payload.reason] ?? "Jugada inválida", "neutral");
    });

    socket.on(MinesServerMessage.FAIRNESS, (payload: MinesFairnessPayload) => {
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
  }, [token, stake, size, showBanner, cellCenter, shake, markBrokenHeart]);

  // -------------------------------------------------------------------------
  // Reloj del turno + bucle de particulas
  // -------------------------------------------------------------------------
  useEffect(() => {
    let frame = 0;
    let last = performance.now();

    const loop = (now: number): void => {
      frame = requestAnimationFrame(loop);
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;

      setTurnLeft(Math.max(0, turnDeadlineRef.current - now));

      const canvas = canvasRef.current;
      const particles = particlesRef.current;
      particles.update(dt);
      if (!canvas) return;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      if (canvas.width !== Math.round(rect.width * dpr)) {
        canvas.width = Math.round(rect.width * dpr);
        canvas.height = Math.round(rect.height * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      particles.draw(ctx, (x, y) => ({ x, y }), 1);
    };

    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, []);

  /** Pitido en cada segundo de los ultimos 3 del turno propio. */
  useEffect(() => {
    if (!state || state.phase !== "playing") return;
    if (state.currentTurnSeat !== mySeat) return;
    const second = Math.ceil(turnLeft / 1000);
    if (second <= 3 && second > 0 && second !== lastTickRef.current) {
      lastTickRef.current = second;
      gameAudio.play("countdown");
    }
    if (second > 3) lastTickRef.current = -1;
  }, [turnLeft, state, mySeat]);

  // -------------------------------------------------------------------------
  // Jugada
  // -------------------------------------------------------------------------
  const myTurn =
    state?.phase === "playing" && state.currentTurnSeat === mySeat && opponentOnline;

  const reveal = useCallback(
    (index: number) => {
      gameAudio.unlock();
      if (!myTurn || !state) return;
      if (state.revealedTiles[index] !== TILE_HIDDEN) return;
      socketRef.current?.emit(MinesClientMessage.REVEAL, { index });
    },
    [myTurn, state],
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  const myLives = state?.lives[mySeat] ?? MINES_LIVES;
  const rivalLives = state?.lives[mySeat === 0 ? 1 : 0] ?? MINES_LIVES;
  const seconds = Math.ceil(turnLeft / 1000);
  const turnPct = Math.max(0, Math.min(100, (turnLeft / (MINES_TURN_SECONDS * 1000)) * 100));
  const urgent = myTurn && seconds <= 3;
  const revealedMines = new Set(fairness?.positions ?? []);

  return (
    <div className={`game-shell ${shaking ? "shake" : ""}`} onPointerDown={() => gameAudio.unlock()}>
      <header className="hud">
        <div className="hud-side">
          <span className="chip chip-gold">{formatCOP(stake)}</span>
          <span className="chip">pozo {formatCOP(stake * 2)}</span>
          <span className="chip">{state?.mines ?? "?"} minas</span>
        </div>

        <div className="lives-board">
          <Lives label="TÚ" lives={myLives} tone="self" bump={breaking[mySeat] ?? 0} />
          <span className="lives-vs">VS</span>
          <Lives
            label={opponentName || "RIVAL"}
            lives={rivalLives}
            tone="rival"
            bump={breaking[mySeat === 0 ? 1 : 0] ?? 0}
          />
        </div>

        <div className="hud-side hud-side-end">
          {state?.commit && (
            <span className="chip chip-mono" title={`Compromiso del tablero: ${state.commit}`}>
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

      <div className="stage mines-stage">
        <div className="mines-turn">
          <div
            className={`turn-banner ${myTurn ? "turn-mine" : "turn-rival"}`}
            role="status"
            aria-live="polite"
          >
            {state?.phase === "finished"
              ? "PARTIDA TERMINADA"
              : myTurn
                ? "TU TURNO"
                : `TURNO DE ${(opponentName || "TU RIVAL").toUpperCase()}`}
          </div>

          <div className={`turn-clock ${urgent ? "turn-clock-urgent" : ""}`}>
            <span className="turn-seconds">{seconds}</span>
            <div className="turn-bar" aria-hidden>
              <div
                className={`turn-bar-fill ${turnPct < 30 ? "turn-bar-low" : ""}`}
                style={{ width: `${turnPct}%` }}
              />
            </div>
          </div>
        </div>

        <div className="mines-wrap">
          <div
            ref={gridRef}
            className={`mines-grid ${myTurn ? "" : "mines-grid-locked"}`}
            style={{ gridTemplateColumns: `repeat(${state?.size ?? size}, 1fr)` }}
          >
            {(state?.revealedTiles ?? new Array(size * size).fill(TILE_HIDDEN)).map(
              (tile, index) => {
                const revealed = tile !== TILE_HIDDEN;
                const isMine = tile === TILE_MINE;
                const owner = state?.owners[index] ?? -1;
                const fresh = freshRef.current.has(index);
                // Minas que nunca se pisaron, mostradas solo al terminar.
                const exposed = !revealed && revealedMines.has(index);

                return (
                  <button
                    key={index}
                    type="button"
                    className={[
                      "cell",
                      revealed ? "cell-open" : "",
                      fresh ? "cell-fresh" : "",
                      isMine ? "cell-mine-hit" : revealed ? "cell-safe" : "",
                      exposed ? "cell-exposed" : "",
                      owner === mySeat ? "cell-by-me" : owner >= 0 ? "cell-by-them" : "",
                      myTurn && !revealed ? "cell-playable" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={() => reveal(index)}
                    disabled={!myTurn || revealed}
                    aria-label={
                      revealed
                        ? isMine
                          ? "mina"
                          : "casilla segura"
                        : `casilla ${index + 1} sin destapar`
                    }
                  >
                    {/*
                      Contenedor de tamaño fijo (.cell-face es flex +
                      justify-center + items-center, ver globals.css) con un
                      icono SVG de tamaño en PIXELES, no en em/rem. Un emoji
                      de texto trae sus propias metricas de fuente
                      (ascenso/descenso) que varian segun el glifo — eso era
                      lo que hacia "rebotar" la fila al destapar una casilla.
                      Un SVG con `size` fijo no tiene ese problema: mide
                      siempre exactamente lo mismo, este vacio o no.
                    */}
                    <span className="cell-face">
                      {isMine || exposed ? (
                        <Skull
                          size={26}
                          strokeWidth={2}
                          className={`cell-icon-mine ${exposed ? "cell-icon-exposed" : ""}`}
                          aria-hidden
                        />
                      ) : revealed ? (
                        <Gem size={26} strokeWidth={2} className="cell-icon-safe" aria-hidden />
                      ) : null}
                    </span>
                  </button>
                );
              },
            )}
          </div>
          <canvas ref={canvasRef} className="mines-fx" aria-hidden />
        </div>

        <p className="note mines-hint">
          Una casilla por turno. No hay pistas: ninguna casilla dice nada de sus vecinas.
          {state ? ` Quedan ${state.safeRemaining} seguras.` : ""}
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

        <MinesPanel
          status={status}
          stake={stake}
          mySeat={mySeat}
          safeRevealed={safeRevealedRef.current}
          onRematch={onRematch}
        />
      </div>
    </div>
  );
}

/** Fila de corazones de un jugador. */
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
      <span className="lives-hearts" aria-label={`${lives} de ${MINES_LIVES} vidas`}>
        {Array.from({ length: MINES_LIVES }, (_, i) => {
          const alive = i < lives;
          // `bump` cambia cada vez que este jugador pierde una vida: sirve de
          // clave para reiniciar la animacion de rotura.
          return (
            <span
              key={`${i}-${alive ? "on" : `off-${bump}`}`}
              className={`heart ${alive ? "heart-on" : "heart-off"}`}
              aria-hidden
            >
              <Heart size={18} strokeWidth={2.2} fill={alive ? "currentColor" : "none"} />
            </span>
          );
        })}
      </span>
    </div>
  );
}

function MinesPanel({
  status,
  stake,
  mySeat,
  safeRevealed,
  onRematch,
}: {
  status: Status;
  stake: number;
  mySeat: Seat;
  safeRevealed: number;
  onRematch: () => void;
}) {
  if (status.kind === "playing") return null;

  if (status.kind === "finished") {
    const { result } = status;
    const voided = result.payout === null;

    // La pantalla "jackpot" es solo para una victoria real: perder o
    // empatar (tablero despejado con las mismas vidas) son desenlaces
    // sobrios, no hay nada que celebrar ahi.
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
              value: `${result.scores[mySeat]} / ${MINES_LIVES}`,
            },
            {
              icon: <Gem size={18} strokeWidth={2.2} />,
              label: "Casillas seguras destapadas",
              value: String(safeRevealed),
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
  if (reason.includes("invalid_size")) return "Tamaño de tablero no permitido.";
  if (reason.includes("resume_expired")) return "La partida ya terminó.";
  if (reason.includes("expired_token")) return "Tu sesión expiró. Vuelve a entrar.";
  if (reason.includes("user_blocked")) return "Tu cuenta no puede apostar en este momento.";
  return "No se pudo iniciar la partida. No se cobró nada.";
}
