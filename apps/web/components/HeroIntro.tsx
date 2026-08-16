"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { animate, motion, useReducedMotion } from "framer-motion";
import { Bomb, Gamepad2, Spade } from "lucide-react";
import { formatCOP } from "@ah/shared";
import { gameAudio } from "@/lib/audio";

/**
 * Duracion total de la intro en escritorio (ms): Fase A 0-1.2s (golpe
 * inicial) · Fase B 1.2-2.8s (contador LED) · Fase C 2.8-4.0s (flash dorado +
 * apertura del lobby). Un solo temporizador manda `onFinish`; todo lo demas
 * es puesta en escena repartida en ese mismo tiempo con sus propios delays.
 */
const INTRO_MS_DESKTOP = 4000;

/**
 * En movil la intro es deliberadamente mas corta y mas simple (ver
 * `MobileIntro` mas abajo): sin canvas de particulas, sin `box-shadow`
 * animado, sin conic-gradient rotando. Menos tiempo tambien significa menos
 * tiempo pagando el costo de CUALQUIER animacion en un equipo mas lento.
 */
const INTRO_MS_MOBILE = 1700;

/** Punto de corte movil/escritorio. Mismo criterio que el resto del sitio (`lg:` de Tailwind = 1024px de ancho de VENTANA, pero aca es sobre el dispositivo en si). */
const MOBILE_BREAKPOINT_PX = 768;

/**
 * Detecta movil por media query (no por `window.innerWidth` suelto: eso no
 * reacciona a una rotacion de pantalla ni a la barra de direcciones del
 * navegador achicando el viewport). Arranca en `false` para coincidir con el
 * primer render del servidor (que no conoce el viewport) y se corrige apenas
 * monta — un parpadeo de un frame es preferible a un error de hidratacion.
 */
function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX - 1}px)`);
    const update = () => setIsMobile(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);

  return isMobile;
}

const SHOWCASE_GAMES = [
  { icon: Gamepad2, label: "Air Hockey", tone: "cyan" },
  { icon: Bomb, label: "Minas 1v1", tone: "magenta" },
  { icon: Spade, label: "Blackjack Arena", tone: "gold" },
] as const;

const POT_TARGET = 1_000_000;

/** Contador LED $0 -> $1.000.000, de cyan a amarillo neon. */
function JackpotCounter() {
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    const controls = animate(0, POT_TARGET, {
      duration: 1.3,
      delay: 0.1,
      ease: "easeOut",
      onUpdate: (v) => setDisplay(Math.round(v)),
    });
    return () => controls.stop();
  }, []);

  return (
    <motion.span
      className="hero-intro-led"
      initial={{ color: "#06b6d4" }}
      animate={{ color: "#facc15" }}
      transition={{ duration: 1.4, delay: 0.1, ease: "easeOut" }}
    >
      {formatCOP(display)}
    </motion.span>
  );
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vrot: number;
  kind: "chip" | "bill";
  color: string;
  size: number;
  life: number;
  /** Profundidad simulada: mas cerca de la camara = mas grande y mas rapida. */
  z: number;
}

const PARTICLE_COLORS = ["#f59e0b", "#fde68a", "#ffd700", "#06b6d4"];
const GRAVITY = 0.34;

/**
 * Lluvia de fichas doradas y billetes en Canvas 2D: mucho mas barato que
 * animar decenas de nodos DOM por frame. Arranca con una ráfaga desde el
 * centro al montar y sigue goteando solo durante la Fase A (~1.3s) para no
 * competir con el contador de la Fase B; cada particula se apaga sola
 * (`life`), asi que no hace falta limpiar nada a mano al final.
 */
function useJackpotRain(canvasRef: RefObject<HTMLCanvasElement>, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const particles: Particle[] = [];
    const spawnBurst = (n: number) => {
      const cx = window.innerWidth / 2;
      const cy = window.innerHeight / 2;
      for (let i = 0; i < n; i++) {
        // Profundidad simulada: particulas "cercanas" (z alto) salen mas
        // rapido y grandes, las "lejanas" (z bajo) mas lentas y chicas — el
        // estallido se siente radial en 3D, no un circulo plano de fichas.
        const z = 0.45 + Math.random() * 1.35;
        const angle = Math.random() * Math.PI * 2;
        const speed = (4.5 + Math.random() * 10) * (0.55 + z * 0.5);
        particles.push({
          x: cx,
          y: cy,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 5,
          rot: Math.random() * Math.PI,
          vrot: (Math.random() - 0.5) * 0.3,
          kind: Math.random() < 0.6 ? "chip" : "bill",
          color: PARTICLE_COLORS[Math.floor(Math.random() * PARTICLE_COLORS.length)],
          size: (11 + Math.random() * 11) * z,
          life: 1,
          z,
        });
      }
    };

    // El estallido pasa en la Fase A: se corta el goteo apenas termina
    // (~1.3s) en vez de seguir hasta entrada la Fase B. Asi el contador no
    // compite por atencion (ni por CPU) con fichas nuevas cayendo — cada
    // fase tiene su propio momento en vez de que todo se sienta amontonado.
    spawnBurst(90);
    const spawnLoop = setInterval(() => spawnBurst(16), 200);
    const stopSpawn = setTimeout(() => clearInterval(spawnLoop), 1300);

    let raf = 0;
    const groundY = () => window.innerHeight * 0.94;

    const tick = () => {
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.vy += GRAVITY;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vrot;

        const ground = groundY();
        if (p.y > ground) {
          p.y = ground;
          p.vy *= -0.42;
          p.vx *= 0.86;
        }

        p.life -= 0.0065;
        if (p.life <= 0) {
          particles.splice(i, 1);
          continue;
        }

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
        // Nada de `ctx.shadowBlur`: con decenas de particulas por frame es
        // uno de los costos mas altos que tiene Canvas2D — el brillo lo pone
        // el glow ambiental de CSS de atras, no cada ficha por su cuenta.
        if (p.kind === "chip") {
          ctx.beginPath();
          ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
          ctx.fillStyle = p.color;
          ctx.fill();
          ctx.strokeStyle = "rgba(255,255,255,0.85)";
          ctx.lineWidth = 2;
          ctx.setLineDash([3, 3]);
          ctx.stroke();
        } else {
          ctx.fillStyle = "rgba(4, 30, 20, 0.92)";
          ctx.fillRect(-p.size * 0.95, -p.size * 0.58, p.size * 1.9, p.size * 1.16);
          ctx.strokeStyle = p.color;
          ctx.lineWidth = 1.5;
          ctx.strokeRect(-p.size * 0.95, -p.size * 0.58, p.size * 1.9, p.size * 1.16);
          ctx.fillStyle = p.color;
          ctx.font = `${p.size * 0.95}px sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("$", 0, 1);
        }
        ctx.restore();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      clearInterval(spawnLoop);
      clearTimeout(stopSpawn);
      window.removeEventListener("resize", resize);
    };
  }, [canvasRef, enabled]);
}

/**
 * Opening "JACKPOT 1v1" antes del lobby: el momento exacto en que una
 * tragamonedas revienta el pozo. Puesta en escena pura — no hay logica de
 * juego aca. `onFinish` (temporizador, boton SALTAR o ESC) es lo unico que
 * el padre (`page.tsx`) necesita para ocultar la intro y recordar en
 * sessionStorage que ya se vio.
 *
 * ---------------------------------------------------------------------------
 * Linea base movil
 * ---------------------------------------------------------------------------
 * En escritorio esto es la version completa (`DesktopScene`, sin tocar): 4s,
 * canvas de particulas, contador LED, marquesina, rayos girando y un flash
 * de `box-shadow` a pantalla completa. Nada de eso es gratis, y un telefono
 * de gama media puede tardar mas en un solo frame de `box-shadow` animado a
 * pantalla completa que todo el presupuesto de 16ms de ese frame.
 *
 * `<768px` (`useIsMobile`) cambia a `MobileScene`: mismo golpe visual —
 * titulo + flash dorado — pero sin canvas, sin `box-shadow` animado, sin
 * conic-gradient rotando, y con un texto-shadow del titulo mucho mas liviano.
 * Todo lo que anima en movil es `transform`/`opacity`, que es lo unico que
 * el compositor puede mover sin volver a pintar el arbol entero.
 */
export function HeroIntro({ onFinish }: { onFinish: () => void }) {
  const reduceMotion = useReducedMotion();
  const isMobile = useIsMobile();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const introMs = isMobile ? INTRO_MS_MOBILE : INTRO_MS_DESKTOP;

  // La lluvia de fichas es Canvas2D a 60fps: el gasto mas alto de toda la
  // intro. Se desactiva enteramente en movil, no solo se dibuja mas chica.
  useJackpotRain(canvasRef, !reduceMotion && !isMobile);

  useEffect(() => {
    // Quien prefiere menos movimiento no deberia esperar ni la version corta:
    // se salta directo, igual que si tocara "SALTAR".
    if (reduceMotion) {
      onFinish();
      return;
    }
    const timer = setTimeout(onFinish, introMs);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onFinish();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, [reduceMotion, introMs, onFinish]);

  useEffect(() => {
    // El navegador bloquea el audio hasta el primer gesto real: no hay forma
    // de garantizar que suene desde el frame 0. Si el usuario interactua en
    // algun momento de la intro (click, toque, tecla — incluso SALTAR o ESC
    // cuentan), se desbloquea `gameAudio` ahi mismo y se programa la cascada
    // solo para el tiempo que le queda a la intro, no desde el principio.
    if (reduceMotion) return;
    const startedAt = performance.now();
    let started = false;

    const onFirstGesture = () => {
      if (started) return;
      started = true;
      gameAudio.unlock();
      const remaining = introMs - (performance.now() - startedAt);
      gameAudio.playCoinCascade(Math.max(300, remaining));
      window.removeEventListener("pointerdown", onFirstGesture);
      window.removeEventListener("keydown", onFirstGesture);
    };

    window.addEventListener("pointerdown", onFirstGesture);
    window.addEventListener("keydown", onFirstGesture);
    return () => {
      window.removeEventListener("pointerdown", onFirstGesture);
      window.removeEventListener("keydown", onFirstGesture);
    };
  }, [reduceMotion, introMs]);

  if (reduceMotion) return null;

  return (
    <motion.div
      className="hero-intro"
      initial={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 1.05 }}
      transition={{ duration: 0.4, ease: "easeInOut" }}
    >
      <button type="button" className="hero-intro-skip" onClick={onFinish}>
        SALTAR <span>[ESC]</span>
      </button>

      {isMobile ? <MobileScene /> : <DesktopScene canvasRef={canvasRef} />}
    </motion.div>
  );
}

/** Version completa, sin cambios: escritorio se queda con toda la puesta en escena. */
function DesktopScene({ canvasRef }: { canvasRef: RefObject<HTMLCanvasElement> }) {
  return (
    <div className="hero-intro-shake">
      <div className="hero-intro-ambient" aria-hidden>
        <div className="hero-intro-ambient-glow" />
        <div className="hero-intro-ambient-grid" />
        <div className="hero-intro-ambient-rays" />
      </div>

      <canvas ref={canvasRef} className="hero-intro-canvas" aria-hidden />
      <div className="hero-intro-flash" aria-hidden />
      <div className="hero-intro-strobe" aria-hidden />

      {/* Fase A (0 - 1.2s): el golpe inicial */}
      <motion.div
        className="hero-intro-phase"
        initial={{ opacity: 0 }}
        animate={{ opacity: [0, 1, 1, 0] }}
        transition={{ duration: 1.2, times: [0, 0.12, 0.82, 1], ease: "easeInOut" }}
      >
        <motion.h1
          className="hero-intro-title"
          initial={{ scale: 0.5, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
        >
          ¡JACKPOT 1VS1!
        </motion.h1>
      </motion.div>

      {/* Fase B (1.2 - 2.8s): contador LED descontrolado */}
      <motion.div
        className="hero-intro-phase"
        initial={{ opacity: 0 }}
        animate={{ opacity: [0, 1, 1, 0] }}
        transition={{ duration: 1.6, delay: 1.2, times: [0, 0.08, 0.85, 1], ease: "easeInOut" }}
      >
        <JackpotCounter />
        <p className="hero-intro-led-label">SE REVIENTA EL POZO</p>

        <div className="hero-intro-marquee">
          <motion.div
            className="hero-intro-marquee-track"
            initial={{ x: "100%" }}
            animate={{ x: "-100%" }}
            transition={{ duration: 1.5, delay: 0.15, ease: "linear" }}
          >
            {SHOWCASE_GAMES.map((g) => (
              <div key={g.label} className={`hero-intro-mcard hero-intro-mcard-${g.tone}`}>
                <g.icon size={18} strokeWidth={2.2} aria-hidden />
                <span className="hero-intro-mcard-title">{g.label}</span>
                <span className="hero-intro-mcard-stamp">100% MULTIPLICADOR HABILIDAD</span>
              </div>
            ))}
          </motion.div>
        </div>
      </motion.div>

      {/* Fase C (2.8 - 4.0s): flash de victoria + apertura del lobby */}
      <motion.div
        className="hero-intro-phase"
        initial={{ opacity: 0 }}
        animate={{ opacity: [0, 1, 1] }}
        transition={{ duration: 1.2, delay: 2.8, times: [0, 0.25, 1], ease: "easeInOut" }}
      >
        <p className="hero-intro-final">MULTIPLICA TU DINERO • DUELOS EN TIEMPO REAL</p>
      </motion.div>

      <motion.div
        className="hero-intro-goldblast"
        aria-hidden
        initial={{ opacity: 0, scale: 0.3 }}
        animate={{ opacity: [0, 1, 0], scale: [0.3, 2.8, 3.6] }}
        transition={{ duration: 0.9, delay: 3.1, ease: "easeIn" }}
      />
    </div>
  );
}

/**
 * Version movil: mismo golpe visual (titulo + flash dorado), nada mas.
 *
 * Todo lo que se corta respecto de `DesktopScene`, y por que:
 *   - canvas de particulas: un `requestAnimationFrame` dibujando decenas de
 *     formas por cuadro, el gasto mas alto de la intro entera.
 *   - `.hero-intro-strobe`: anima `box-shadow` directamente en un elemento a
 *     pantalla completa — una de las propiedades mas caras de animar en CSS,
 *     porque obliga a repintar en vez de solo recomponer capas.
 *   - `.hero-intro-ambient-rays`: `repeating-conic-gradient` girando sin
 *     parar; caro de rasterizar en varias GPUs de gama media/baja.
 *   - contador LED + marquesina: menos nodos, menos reflow, y el contador
 *     ademas fuerza un render de React por cada `onUpdate` de la cuenta.
 *
 * Lo que queda son solo tres animaciones, las tres de `transform`/`opacity`
 * puro: el shake (ya era barato), el titulo con scale+opacity, y el flash
 * final con scale+opacity — todo lo que el compositor puede mover sin tocar
 * el hilo principal de pintado.
 */
function MobileScene() {
  return (
    <div className="hero-intro-shake">
      <div className="hero-intro-ambient-glow hero-intro-ambient-glow-static" aria-hidden />

      <motion.div
        className="hero-intro-phase"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.25 }}
      >
        <motion.h1
          className="hero-intro-title hero-intro-title-light"
          initial={{ scale: 0.85, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
        >
          ¡JACKPOT 1VS1!
        </motion.h1>
        <motion.p
          className="hero-intro-final"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.35, delay: 0.25 }}
        >
          MULTIPLICA TU DINERO • DUELOS EN TIEMPO REAL
        </motion.p>
      </motion.div>

      <motion.div
        className="hero-intro-goldblast"
        aria-hidden
        initial={{ opacity: 0, scale: 0.3 }}
        animate={{ opacity: [0, 1, 0], scale: [0.3, 2.4, 3] }}
        transition={{ duration: 0.7, delay: 0.85, ease: "easeIn" }}
      />
    </div>
  );
}
