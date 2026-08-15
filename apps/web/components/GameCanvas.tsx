"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { Coins, Trophy, Wallet } from "lucide-react";
import {
  ClientMessage,
  GOALS_TO_WIN,
  INPUT_SEND_HZ,
  MALLET_RADIUS,
  MalletPredictor,
  NetworkClock,
  ServerMessage,
  SnapshotBuffer,
  TICK_MS,
  clampTargetToOwnHalf,
  decodeState,
  encodeInput,
  formatCOP,
  type EscrowFailedPayload,
  type GoalPayload,
  type JoinedPayload,
  type MatchResultPayload,
  type PongPayload,
  type Seat,
} from "@ah/shared";
import { clearResumeToken, connect, saveResumeToken } from "@/lib/gameSocket";
import { computeView, screenToWorld, Renderer, type View } from "@/lib/render";
import { ImpactDetector } from "@/lib/impacts";
import { gameAudio } from "@/lib/audio";
import { seatColor } from "@/lib/theme";
import VictoryScreen from "@/components/VictoryScreen";

type Status =
  | { kind: "connecting" }
  | { kind: "queued" }
  | { kind: "playing" }
  | { kind: "reconnecting" }
  | { kind: "error"; message: string }
  | { kind: "finished"; result: MatchResultPayload };

interface Banner {
  /** Cambia en cada disparo para reiniciar la animacion CSS. */
  id: number;
  text: string;
  tone: "goal" | "win" | "lose" | "neutral";
  sub?: string;
}

interface NetStats {
  rttMs: number;
  interpolationMs: number;
  snapshotsPerSecond: number;
  downstreamBps: number;
  /** Coste de dibujar un fotograma, en ms. A 60 fps el presupuesto es 16.7. */
  frameMs: number;
  fps: number;
  corrections: number;
}

interface Props {
  token: string;
  stake: number;
  /**
   * Vuelve a buscar partida con la misma apuesta. La implementa la pagina
   * contenedora forzando un remount (cambio de `key`) de este componente:
   * la forma mas simple de repetir el mismo flujo de conexion ya probado,
   * en vez de inventar un segundo camino de "reconectar sin desmontar".
   */
  onRematch: () => void;
}

/**
 * Cliente del juego.
 *
 * Responsabilidades, y ninguna mas:
 *   1. Conectar el socket autenticado.
 *   2. Traducir el puntero a intencion, predecirla localmente y enviarla.
 *   3. Dibujar el estado que llega del servidor, interpolado, con todo el
 *      maquillaje que haga falta.
 *
 * Los efectos —particulas, brillos, sacudidas, sonido— son estrictamente
 * decorativos. Se pueden borrar enteros y la partida seria identica: ninguno
 * toca la fisica, el marcador ni el dinero, que siguen viviendo solo en el
 * servidor.
 */
export default function GameCanvas({ token, stake, onRematch }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const socketRef = useRef<Socket | null>(null);

  const bufferRef = useRef(new SnapshotBuffer());
  const clockRef = useRef(new NetworkClock());
  const predictorRef = useRef(new MalletPredictor());
  const rendererRef = useRef(new Renderer());
  const impactsRef = useRef(new ImpactDetector());
  const viewRef = useRef<View>(computeView(1, 1, false));

  const mySeatRef = useRef<Seat>(0);
  const targetRef = useRef<{ x: number; y: number } | null>(null);
  const seqRef = useRef(0);
  const opponentRef = useRef({ connected: true, reconnectMs: 0 });
  const lastCountdownSecondRef = useRef(-1);
  const meterRef = useRef({ bytes: 0, frames: 0, renderFrames: 0, renderMs: 0, since: 0 });
  const rttRef = useRef(0);
  const bannerIdRef = useRef(0);

  const [status, setStatus] = useState<Status>({ kind: "connecting" });
  const [opponentName, setOpponentName] = useState("");
  const [scores, setScores] = useState<[number, number]>([0, 0]);
  const [mySeat, setMySeat] = useState<Seat>(0);
  const [opponentOnline, setOpponentOnline] = useState(true);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [muted, setMuted] = useState(false);
  const [net, setNet] = useState<NetStats>({
    rttMs: 0,
    interpolationMs: 0,
    snapshotsPerSecond: 0,
    downstreamBps: 0,
    frameMs: 0,
    fps: 0,
    corrections: 0,
  });

  const showBanner = useCallback((text: string, tone: Banner["tone"], sub?: string) => {
    setBanner({ id: ++bannerIdRef.current, text, tone, sub });
  }, []);

  useEffect(() => setMuted(gameAudio.isMuted), []);

  // -------------------------------------------------------------------------
  // Conexion
  // -------------------------------------------------------------------------
  useEffect(() => {
    const socket = connect(token, { stake, game: "air_hockey" });
    socketRef.current = socket;
    meterRef.current.since = performance.now();

    socket.on("connect_error", (error: Error) => {
      setStatus({ kind: "error", message: describeError(error.message) });
    });

    socket.on(ServerMessage.QUEUED, () => setStatus({ kind: "queued" }));

    socket.on(ServerMessage.JOINED, (payload: JoinedPayload) => {
      mySeatRef.current = payload.seat;
      setMySeat(payload.seat);
      setOpponentName(payload.opponentName);
      // Guardar la credencial de reanudacion ANTES de jugar: si el navegador
      // se cae en el primer segundo, la apuesta ya esta bloqueada.
      saveResumeToken(payload.resumeToken);
      predictorRef.current.reset();
      rendererRef.current.reset();
      impactsRef.current.reset();
      setStatus({ kind: "playing" });
      showBanner("¡A JUGAR!", "neutral", `Primero en llegar a ${GOALS_TO_WIN}`);
      gameAudio.play("start");
    });

    socket.on(ServerMessage.STATE, (raw: ArrayBuffer) => {
      const state = decodeState(raw);
      if (!state) return;

      const now = performance.now();
      bufferRef.current.push(state);
      clockRef.current.observe(state.tick * TICK_MS, now);

      const seat = mySeatRef.current;
      predictorRef.current.reconcile(state.mallets[seat], state.mallets[seat].ackSeq);

      const rivalSeat = seat === 0 ? 1 : 0;
      opponentRef.current = {
        connected: state.connected[rivalSeat],
        reconnectMs: state.reconnectMs[rivalSeat],
      };
      setOpponentOnline(state.connected[rivalSeat]);
      setScores(state.scores);

      // Impactos: solo efectos. Se deducen del flujo de estado, sin gastar
      // ancho de banda en eventos de rebote.
      const renderer = rendererRef.current;
      for (const impact of impactsRef.current.detect(state.puck, state.mallets)) {
        if (impact.kind === "wall") {
          renderer.particles.wallImpact(impact.x, impact.y, impact.nx, impact.ny, impact.intensity);
          renderer.bump(2 + impact.intensity * 5);
          gameAudio.play("wall", impact.intensity);
        } else {
          // El mazo que golpeo es el de la mitad donde esta el disco.
          const hitterSeat: Seat = state.puck.y > 500 ? 0 : 1;
          renderer.particles.malletHit(
            impact.x,
            impact.y,
            seatColor(hitterSeat, seat),
            impact.intensity,
          );
          renderer.bump(3 + impact.intensity * 7);
          gameAudio.play("hit", impact.intensity);
        }
      }

      // Pitido en cada segundo de la cuenta regresiva.
      if (state.phase === "countdown") {
        const second = Math.ceil(state.countdownMs / 1000);
        if (second !== lastCountdownSecondRef.current && second > 0) {
          lastCountdownSecondRef.current = second;
          gameAudio.play("countdown");
        }
      } else {
        lastCountdownSecondRef.current = -1;
      }

      const meter = meterRef.current;
      meter.bytes += raw.byteLength;
      meter.frames += 1;
      const elapsed = now - meter.since;
      if (elapsed >= 1000) {
        setNet({
          rttMs: Math.round(rttRef.current),
          interpolationMs: Math.round(clockRef.current.interpolationDelayMs),
          snapshotsPerSecond: Math.round((meter.frames / elapsed) * 1000),
          downstreamBps: Math.round((meter.bytes / elapsed) * 1000),
          frameMs: meter.renderFrames > 0 ? +(meter.renderMs / meter.renderFrames).toFixed(2) : 0,
          fps: Math.round((meter.renderFrames / elapsed) * 1000),
          corrections: predictorRef.current.stats.corrections,
        });
        meter.bytes = 0;
        meter.frames = 0;
        meter.renderFrames = 0;
        meter.renderMs = 0;
        meter.since = now;
      }
    });

    socket.on(ServerMessage.GOAL, (payload: GoalPayload) => {
      const seat = mySeatRef.current;
      const scoredByMe = payload.scorerSeat === seat;
      // El asiento 0 ataca el arco de arriba (indice 0), el 1 el de abajo.
      rendererRef.current.celebrateGoal(
        payload.scorerSeat === 0 ? 0 : 1,
        seatColor(payload.scorerSeat, seat),
      );
      setScores(payload.scores);
      showBanner(
        scoredByMe ? "¡GOL!" : "GOL DEL RIVAL",
        scoredByMe ? "goal" : "lose",
        `${payload.scores[seat]} — ${payload.scores[seat === 0 ? 1 : 0]}`,
      );
      gameAudio.play("goal");
    });

    socket.on(ServerMessage.MATCH_RESULT, (result: MatchResultPayload) => {
      clearResumeToken();
      setStatus({ kind: "finished", result });
      if (result.payout === null) {
        showBanner("ANULADA", "neutral", "Se devolvió tu apuesta");
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

    socket.on(ServerMessage.OPPONENT, (payload: { connected: boolean; reconnectMs: number }) => {
      opponentRef.current = payload;
      setOpponentOnline(payload.connected);
    });

    socket.on(ServerMessage.PONG, (payload: PongPayload) => {
      // Media movil: un solo pong atipico no debe hacer saltar el indicador.
      const sample = performance.now() - payload.t;
      rttRef.current = rttRef.current === 0 ? sample : rttRef.current * 0.8 + sample * 0.2;
    });

    socket.io.on("reconnect_attempt", () => {
      setStatus((current) => (current.kind === "finished" ? current : { kind: "reconnecting" }));
    });

    socket.io.on("reconnect", () => {
      bufferRef.current.clear();
      clockRef.current.reset();
      predictorRef.current.reset();
      impactsRef.current.reset();
      rendererRef.current.reset();
      setStatus({ kind: "playing" });
    });

    socket.io.on("reconnect_failed", () => {
      setStatus({ kind: "error", message: "No se pudo restablecer la conexión." });
    });

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [token, stake, showBanner]);

  // -------------------------------------------------------------------------
  // Envio de intencion + prediccion local
  // -------------------------------------------------------------------------
  useEffect(() => {
    // El envio corre a la misma frecuencia que el tick del servidor. Esa
    // igualdad es lo que hace que la reconciliacion sea exacta.
    const inputTimer = setInterval(() => {
      const socket = socketRef.current;
      const target = targetRef.current;
      if (!socket?.connected || !target) return;

      const seq = (seqRef.current = (seqRef.current + 1) & 0xffff);
      const input = { seq, x: target.x, y: target.y };
      // Primero se aplica localmente (respuesta inmediata), despues se envia.
      predictorRef.current.applyLocal(input);
      socket.emit(ClientMessage.INPUT, encodeInput(input));
    }, 1000 / INPUT_SEND_HZ);

    const pingTimer = setInterval(() => {
      socketRef.current?.emit(ClientMessage.PING, { t: performance.now() });
    }, 1000);

    return () => {
      clearInterval(inputTimer);
      clearInterval(pingTimer);
    };
  }, []);

  // -------------------------------------------------------------------------
  // Puntero
  // -------------------------------------------------------------------------
  const handlePointer = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const world = screenToWorld(
      viewRef.current,
      event.clientX - rect.left,
      event.clientY - rect.top,
    );
    // Recorte local: no es seguridad (el servidor recorta igual), es no gastar
    // mensajes en coordenadas que se sabe que van a ser rechazadas.
    targetRef.current = clampTargetToOwnHalf(world.x, world.y, mySeatRef.current, MALLET_RADIUS);
  }, []);

  /** El navegador exige un gesto real antes de dejar sonar nada. */
  const unlockAudio = useCallback(() => gameAudio.unlock(), []);

  // -------------------------------------------------------------------------
  // Bucle de render
  // -------------------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let frame = 0;
    let lastFrameTime = performance.now();
    const renderer = rendererRef.current;

    const resize = (): void => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      viewRef.current = computeView(rect.width, rect.height, mySeatRef.current === 1);
      renderer.setView(viewRef.current);
    };

    resize();
    window.addEventListener("resize", resize);

    const loop = (now: number): void => {
      frame = requestAnimationFrame(loop);

      const dt = Math.min((now - lastFrameTime) / 1000, 0.1);
      lastFrameTime = now;

      // El asiento puede llegar despues del primer resize.
      if (viewRef.current.flip !== (mySeatRef.current === 1)) {
        viewRef.current = computeView(
          viewRef.current.cssWidth,
          viewRef.current.cssHeight,
          mySeatRef.current === 1,
        );
      }
      renderer.setView(viewRef.current);

      const clock = clockRef.current;
      const renderServerMs = clock.serverTimeAt(now) - clock.interpolationDelayMs;
      const state = bufferRef.current.sample(renderServerMs);
      if (!state) return;

      renderer.particles.trackPuck(
        state.puck.x,
        state.puck.y,
        Math.hypot(state.puck.vx, state.puck.vy),
      );

      renderer.draw(ctx, dt, {
        state,
        mySeat: mySeatRef.current,
        // El mazo propio sale de la prediccion, no del estado interpolado:
        // por eso responde en el mismo fotograma.
        myMallet: predictorRef.current.render(),
        opponentConnected: opponentRef.current.connected,
        opponentReconnectMs: opponentRef.current.reconnectMs,
      });

      const meter = meterRef.current;
      meter.renderFrames += 1;
      meter.renderMs += renderer.lastFrameMs;
    };

    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
    };
  }, []);

  const myScore = scores[mySeat];
  const theirScore = scores[mySeat === 0 ? 1 : 0];

  return (
    <div className="game-shell" onPointerDown={unlockAudio}>
      <header className="hud">
        <div className="hud-side">
          <span className="chip chip-gold">{formatCOP(stake)}</span>
          <span className="chip" title="Pozo en juego">
            pozo {formatCOP(stake * 2)}
          </span>
        </div>

        <div className="scoreboard" role="status" aria-live="polite">
          <div className="score score-self">
            <span className="score-name">TÚ</span>
            <span className="score-value">{myScore}</span>
          </div>
          <span className="score-sep">:</span>
          <div className="score score-rival">
            <span className="score-value">{theirScore}</span>
            <span className="score-name">{opponentName || "RIVAL"}</span>
          </div>
        </div>

        <div className="hud-side hud-side-end">
          <span className="chip chip-mono" title="Ida y vuelta al servidor">
            {net.rttMs} ms
          </span>
          <span className="chip chip-mono" title="Instantáneas por segundo · ancho de banda">
            {net.snapshotsPerSecond} Hz · {(net.downstreamBps / 1024).toFixed(1)} KB/s
          </span>
          <span
            className={`chip chip-mono ${net.frameMs > 12 ? "chip-warn" : ""}`}
            title="Coste de dibujar un fotograma (presupuesto 16.7 ms) y FPS"
          >
            {net.frameMs} ms · {net.fps} fps
          </span>
          <button
            type="button"
            className="chip chip-button"
            onClick={() => {
              gameAudio.unlock();
              setMuted(gameAudio.toggleMute());
            }}
            aria-label={muted ? "Activar sonido" : "Silenciar"}
          >
            {muted ? "🔇" : "🔊"}
          </button>
        </div>
      </header>

      <div className="stage">
        <canvas
          ref={canvasRef}
          className="game-canvas"
          onPointerMove={handlePointer}
          onPointerDown={handlePointer}
          style={{ touchAction: "none" }}
        />

        {banner && (
          <div key={banner.id} className={`banner banner-${banner.tone}`}>
            <span className="banner-text">{banner.text}</span>
            {banner.sub && <span className="banner-sub">{banner.sub}</span>}
          </div>
        )}

        {!opponentOnline && status.kind === "playing" && (
          <div className="alert">
            <strong>Rival desconectado</strong>
            <span>Si no vuelve, ganas la partida</span>
          </div>
        )}

        <StatusPanel status={status} stake={stake} mySeat={mySeat} onRematch={onRematch} />
      </div>
    </div>
  );
}

function StatusPanel({
  status,
  stake,
  mySeat,
  onRematch,
}: {
  status: Status;
  stake: number;
  mySeat: Seat;
  onRematch: () => void;
}) {
  if (status.kind === "playing") return null;

  if (status.kind === "finished") {
    const { result } = status;
    const voided = result.payout === null;

    // La pantalla "jackpot" es solo para una victoria real: perder o que se
    // anule la partida son desenlaces sobrios, no hay nada que celebrar ahi.
    if (!voided && result.youWon) {
      const rivalSeat: Seat = mySeat === 0 ? 1 : 0;
      return (
        <VictoryScreen
          payout={result.payout ?? 0}
          rake={result.rake ?? 0}
          balanceAfter={result.balanceAfter}
          onRematch={onRematch}
          stats={[
            {
              icon: <Trophy size={18} strokeWidth={2.2} />,
              label: "Marcador final",
              value: `${result.scores[mySeat]} — ${result.scores[rivalSeat]}`,
            },
            {
              icon: <Wallet size={18} strokeWidth={2.2} />,
              label: "Apuesta inicial",
              value: formatCOP(stake),
            },
            {
              icon: <Coins size={18} strokeWidth={2.2} />,
              label: "Pozo total",
              value: formatCOP(stake * 2),
            },
          ]}
        />
      );
    }

    return (
      <div className="panel">
        <div className="panel-card">
          <h2 className={voided ? "" : "title-lose"}>
            {voided ? "Partida anulada" : "Perdiste"}
          </h2>
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
  if (reason.includes("invalid_token") || reason.includes("missing_token")) {
    return "Sesión inválida. Vuelve a entrar.";
  }
  return "No se pudo iniciar la partida. No se cobró nada.";
}
