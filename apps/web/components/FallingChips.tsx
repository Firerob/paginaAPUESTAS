"use client";

import { useEffect, useRef } from "react";
import { useReducedMotion } from "framer-motion";

interface FallingChipsProps {
  /** Que margen ocupa: izquierdo o derecho. */
  side: "left" | "right";
  /**
   * Ancho en px reservado a la izquierda por un panel opaco (el chat). Se
   * usa para calcular donde empieza/termina de verdad el contenido
   * centrado del lobby — ver la nota mas abajo sobre por que esto importa.
   */
  leftReserved?: number;
}

interface ChipStyle {
  color: string;
  glow: string;
}

// Mismos colores que las fichas de apuesta del lobby (BetChips.tsx / los
// tokens --self/--cyan/--gold/--purple/--platinum/--ruby de globals.css),
// en hex literal porque un <canvas> no puede leer variables CSS. Cualquier
// apuesta nueva que se agregue alla debe sumar su color aca tambien.
const CHIP_STYLES: ChipStyle[] = [
  { color: "#2bffb0", glow: "rgba(43,255,176,0.8)" }, // verde — 1.000
  { color: "#22e8ff", glow: "rgba(34,232,255,0.8)" }, // cyan — 5.000
  { color: "#ffcf5c", glow: "rgba(255,207,92,0.8)" }, // dorado — 10.000
  { color: "#b967ff", glow: "rgba(185,103,255,0.8)" }, // purpura — 20.000
  { color: "#cbd5e1", glow: "rgba(203,213,225,0.8)" }, // platino — 50.000
  { color: "#e11d48", glow: "rgba(225,29,72,0.8)" }, // rubi — 100.000
];

const RIM_INNER = "#0f172a";
const RIM_DARK = "#020617";
const SEGMENTS = 12;

interface Chip {
  x: number;
  y: number;
  depth: number; // 0 = lejos, 1 = cerca
  size: number; // diametro en px
  speed: number; // px/s
  style: ChipStyle;
  wobblePhase: number;
  wobbleFreq: number;
  wobbleAmp: number;
  flipAngle: number;
  flipSpeed: number;
}

/**
 * Lluvia de fichas de casino neon, contenida a un margen lateral de la
 * pantalla. Fondo puro decorativo — `pointer-events-none` de punta a punta.
 * Sin monto en el centro a proposito: a tamaños chicos y de canto (el
 * `scale` del flip 3D) el texto se deformaba y se veia mal: la ficha sola,
 * con su borde segmentado y su brillo, se lee mejor.
 *
 * SOBRE LAS FRANJAS (1%-12% izquierda, 88%-98% derecha): son el objetivo,
 * pero con dos correcciones necesarias:
 *
 *   1. Margen de radio: el limite de la franja acota el CENTRO de la ficha,
 *      no su borde. Sin restarle el radio maximo (33px) a cada extremo, una
 *      ficha grande centrada justo en el limite invade contenido con la
 *      mitad de su circulo — exactamente el bug reportado (fichas
 *      sobrepuestas a la tarjeta de Air Hockey).
 *   2. Nunca invade donde termina/empieza de verdad el contenido centrado
 *      del lobby (`max-w-6xl` + el ancho que reserva el chat). Con el chat
 *      abierto en un viewport normal, el panel solo (320px) ya cubre mas
 *      que el 12% de la izquierda: sin este chequeo, las fichas de ese lado
 *      volverian a nacer detras del chat y se verian invisibles — el mismo
 *      bug que ya se corrigio una vez en AmbientBackground.
 *
 * La franja fija manda cuando hay espacio de sobra; el borde real del
 * contenido manda cuando la pantalla es angosta o el chat esta abierto.
 */
export function FallingChips({ side, leftReserved = 0 }: FallingChipsProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reducedMotion = useReducedMotion();
  const leftReservedRef = useRef(leftReserved);
  leftReservedRef.current = leftReserved;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const CONTENT_MAX = 1152; // debe calzar con max-w-6xl en page.tsx
    const LEFT_MIN = 0.01;
    const LEFT_MAX = 0.12;
    const RIGHT_MIN = 0.88;
    const RIGHT_MAX = 0.98;
    // Radio de la ficha mas grande (diametro 65px, ver `spawn`). Se resta a
    // los dos extremos de la franja para acotar el CIRCULO, no el centro.
    const MAX_CHIP_RADIUS = 33;

    let width = 0;
    let height = 0;
    let bandStart = 0;
    let bandEnd = 0;
    let chips: Chip[] = [];
    let raf = 0;
    let last = performance.now();
    let active = true; // false en mobile: el canvas ni se anima ni se dibuja

    function computeBand(): void {
      const reserved = leftReservedRef.current;
      const available = Math.max(0, width - reserved);
      const contentWidth = Math.min(available, CONTENT_MAX);
      const sideMargin = Math.max(0, (available - contentWidth) / 2);
      const contentLeft = reserved + sideMargin;
      const contentRight = contentLeft + contentWidth;

      // La franja izquierda va pegada al borde REAL de la pantalla (1%-12%),
      // sin correrse por el chat: si el chat esta abierto, se superpone
      // encima (es un panel opaco de mayor z-index) y listo — eso esta bien,
      // el efecto se ve completo apenas se cierra. Lo unico que la franja
      // izquierda respeta de verdad es el borde del CONTENIDO (las
      // tarjetas), nunca el ancho del chat.
      //
      // La franja derecha si preserva su ancho objetivo deslizandose: ahi no
      // hay ningun panel angosto que la trague por completo como el chat, y
      // sin este ajuste el contenido la recorta hasta desaparecer en
      // pantallas donde `max-w-6xl` llega mas lejos de lo esperado.
      if (side === "right") {
        const targetWidth = width * (RIGHT_MAX - RIGHT_MIN);
        // "98%" tambien se acota con el radio: una ficha centrada ahi con
        // su radio completo se saldria del viewport y se veria cortada.
        const hardEnd = width * RIGHT_MAX - MAX_CHIP_RADIUS;
        const hardStart = Math.max(width * RIGHT_MIN, contentRight) + MAX_CHIP_RADIUS;
        bandStart = Math.max(hardStart, hardEnd - targetWidth);
        bandEnd = Math.max(bandStart, hardEnd);
      } else {
        const hardStart = width * LEFT_MIN + MAX_CHIP_RADIUS;
        const hardEnd = contentLeft - MAX_CHIP_RADIUS;
        bandStart = hardStart;
        bandEnd = Math.max(bandStart, Math.min(width * LEFT_MAX - MAX_CHIP_RADIUS, hardEnd));
      }
    }

    function randomX(): number {
      const w = Math.max(0, bandEnd - bandStart);
      if (w <= 0) return -9999;
      return bandStart + Math.random() * w;
    }

    function spawn(y?: number): Chip {
      const depth = Math.random();
      const style = CHIP_STYLES[Math.floor(Math.random() * CHIP_STYLES.length)];
      return {
        x: randomX(),
        y: y ?? -60,
        depth,
        size: 20 + depth * 45, // 20px lejos -> 65px cerca
        speed: 1.2 + depth * 1.8 + Math.random() * 0.3, // ~1.2 a 3.3 px/frame @60fps
        style,
        wobblePhase: Math.random() * Math.PI * 2,
        wobbleFreq: 0.5 + Math.random() * 0.5,
        wobbleAmp: 6 + Math.random() * 10,
        flipAngle: Math.random() * Math.PI * 2,
        flipSpeed: 0.6 + Math.random() * 0.7,
      };
    }

    function resize(): void {
      width = window.innerWidth;
      height = window.innerHeight;
      active = width >= 1280; // coincide con el breakpoint `xl` de Tailwind, ver el wrapper

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas!.width = width * dpr;
      canvas!.height = height * dpr;
      canvas!.style.width = `${width}px`;
      canvas!.style.height = `${height}px`;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

      computeBand();

      if (!active) {
        chips = [];
        ctx!.clearRect(0, 0, width, height);
        return;
      }

      // Una ficha detallada (12 segmentos de borde) pesa mas de dibujar que
      // una chispa simple: la densidad es mas conservadora que en
      // AmbientBackground, pensada para 60fps con muchas fichas visibles.
      const count = Math.max(14, Math.min(30, Math.round(height / 70)));
      chips = Array.from({ length: count }, () => spawn(Math.random() * height));
      paint(false, 0);
    }

    function drawChip(chip: Chip, flipScaleX: number): void {
      const r = chip.size / 2;

      ctx!.save();
      ctx!.globalAlpha = 0.3 + chip.depth * 0.6; // 0.3 lejos -> 0.9 cerca
      ctx!.translate(chip.x, chip.y);
      ctx!.scale(flipScaleX, 1);

      // Resplandor neon del borde: mas intenso cuanto mas cerca.
      ctx!.shadowColor = chip.style.glow;
      ctx!.shadowBlur = 3 + chip.depth * 9; // hasta 12, como se pidio

      // Borde exterior segmentado, dos colores intercalados.
      const step = (Math.PI * 2) / SEGMENTS;
      for (let i = 0; i < SEGMENTS; i++) {
        ctx!.beginPath();
        ctx!.arc(0, 0, r, i * step, (i + 1) * step);
        ctx!.strokeStyle = i % 2 === 0 ? chip.style.color : RIM_DARK;
        ctx!.lineWidth = Math.max(2, r * 0.28);
        ctx!.stroke();
      }

      // Centro oscuro, liso: sin monto ni simbolo.
      ctx!.shadowBlur = 0;
      ctx!.beginPath();
      ctx!.arc(0, 0, r * 0.68, 0, Math.PI * 2);
      ctx!.fillStyle = RIM_INNER;
      ctx!.fill();

      ctx!.restore();
    }

    function paint(advance: boolean, dt: number): void {
      ctx!.clearRect(0, 0, width, height);
      if (!active) return;

      for (let i = 0; i < chips.length; i++) {
        const chip = chips[i];
        if (advance) {
          chip.y += chip.speed * dt * 60; // normalizado a "px por frame a 60fps"
          chip.flipAngle += chip.flipSpeed * dt;
          chip.wobblePhase += chip.wobbleFreq * dt;
        }

        const drawX = chip.x + Math.sin(chip.wobblePhase) * chip.wobbleAmp * 0.05;
        // Nunca llega a 0: un piso minimo evita que la ficha desaparezca
        // en una linea de un solo pixel al quedar de canto.
        const flipScaleX = Math.max(0.15, Math.abs(Math.sin(chip.flipAngle)));

        const original = chip.x;
        chip.x = drawX;
        drawChip(chip, flipScaleX);
        chip.x = original;

        if (advance && chip.y - chip.size > height) {
          chips[i] = spawn(-chip.size);
        }
      }
    }

    function tick(now: number): void {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      paint(true, dt);
      raf = requestAnimationFrame(tick);
    }

    resize();
    if (!reducedMotion) raf = requestAnimationFrame(tick);

    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [reducedMotion, side]);

  return (
    <div className="hidden xl:block fixed inset-0 z-0 pointer-events-none" aria-hidden>
      <canvas ref={canvasRef} className="absolute inset-0" />
    </div>
  );
}
