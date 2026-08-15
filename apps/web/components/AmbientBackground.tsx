"use client";

import { useEffect, useRef } from "react";
import { motion, useReducedMotion } from "framer-motion";

interface AmbientBackgroundProps {
  /**
   * Ancho en px ocupado por un panel opaco fijo a la izquierda (el chat, por
   * ejemplo). Las chispas de esa franja no se dibujan ahi: da igual cuanto
   * brillen, si nacen detras de un panel solido no se van a ver nunca.
   */
  leftReserved?: number;
}

/**
 * Capa de fondo fija: malla ciberpunk + orbes de neon respirando + chispas
 * de particulas en los margenes laterales. Todo `pointer-events-none`: es
 * decoracion pura, nunca debe robar un click al contenido real.
 *
 * Vive detras de todo (montarla una sola vez cerca de la raiz del layout).
 */
export function AmbientBackground({ leftReserved = 0 }: AmbientBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reducedMotion = useReducedMotion();
  const leftReservedRef = useRef(leftReserved);
  leftReservedRef.current = leftReserved;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const COLORS = ["#06b6d4", "#a855f7"];
    // El contenido del lobby es `max-w-6xl` (1152px) centrado dentro del
    // espacio que le deja el chat. Un porcentaje fijo del viewport para las
    // franjas se equivocaba de margen en pantallas normales: con el chat
    // abierto en un viewport de 1600px, el contenido llega hasta x=1536 y
    // solo quedan 64px libres a la derecha, no el 15% (240px) que se
    // asumia — la franja "vivia" debajo de las tarjetas la mayor parte del
    // tiempo, detras de ellas en el orden de pintado (z-index negativo).
    // Por eso las franjas se calculan contra el ancho REAL del contenido,
    // no contra un porcentaje ciego del viewport.
    const CONTENT_MAX = 1152; // debe calzar con max-w-6xl en page.tsx
    const MIN_BAND = 24; // por debajo de esto no vale la pena poblar la franja

    interface Spark {
      x: number;
      y: number;
      size: number;
      speed: number;
      color: string;
      born: number;
      wobble: number;
      wobbleSpeed: number;
    }

    let width = 0;
    let height = 0;
    let sparks: Spark[] = [];
    let raf = 0;
    let last = performance.now();
    let leftBand = { start: 0, end: 0 };
    let rightBand = { start: 0, end: 0 };

    function computeBands(): void {
      const reserved = leftReservedRef.current;
      const available = Math.max(0, width - reserved);
      const contentWidth = Math.min(available, CONTENT_MAX);
      const sideMargin = Math.max(0, (available - contentWidth) / 2);
      const contentLeft = reserved + sideMargin;
      const contentRight = contentLeft + contentWidth;
      leftBand = { start: reserved, end: contentLeft };
      rightBand = { start: contentRight, end: width };
    }

    function edgeX(): number {
      const leftWidth = leftBand.end - leftBand.start;
      const rightWidth = rightBand.end - rightBand.start;
      const leftOk = leftWidth >= MIN_BAND;
      const rightOk = rightWidth >= MIN_BAND;

      if (!leftOk && !rightOk) return -9999; // no hay margen visible: no dibujar nada util
      const onLeft = leftOk && (!rightOk || Math.random() < 0.5);
      return onLeft
        ? leftBand.start + Math.random() * leftWidth
        : rightBand.start + Math.random() * rightWidth;
    }

    function spawn(y?: number): Spark {
      return {
        x: edgeX(),
        y: y ?? height + 16,
        size: 4 + Math.random() * 4.5,
        speed: 16 + Math.random() * 26,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        born: performance.now(),
        wobble: Math.random() * Math.PI * 2,
        wobbleSpeed: 0.6 + Math.random() * 0.8,
      };
    }

    function resize() {
      width = window.innerWidth;
      height = window.innerHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas!.width = width * dpr;
      canvas!.height = height * dpr;
      canvas!.style.width = `${width}px`;
      canvas!.style.height = `${height}px`;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

      computeBands();

      // La densidad se calcula sobre el AREA REAL de las franjas visibles
      // (no un porcentaje ciego del viewport): si el margen es angosto,
      // caben menos chispas y no se amontonan; si es ancho, se nota el
      // efecto en vez de perderse.
      const leftWidth = Math.max(0, leftBand.end - leftBand.start);
      const rightWidth = Math.max(0, rightBand.end - rightBand.start);
      const bandArea = (leftWidth + rightWidth) * height;
      const count = Math.max(24, Math.min(160, Math.round(bandArea / 9_000)));
      sparks = Array.from({ length: count }, () => spawn(Math.random() * height));

      // Redibuja de inmediato: un resize limpia el canvas, y sin esto se
      // veria en blanco hasta el proximo frame (que no llega si el loop
      // continuo esta apagado por reduced-motion).
      paint(false, 0);
    }

    function drawDiamond(x: number, y: number, size: number, color: string, alpha: number) {
      ctx!.save();
      ctx!.globalAlpha = Math.max(0, Math.min(1, alpha));
      ctx!.translate(x, y);
      ctx!.rotate(Math.PI / 4);
      ctx!.shadowColor = color;
      ctx!.shadowBlur = size * 4;
      ctx!.fillStyle = color;
      ctx!.fillRect(-size / 2, -size / 2, size, size);
      ctx!.restore();
    }

    function paint(advance: boolean, dt: number) {
      ctx!.clearRect(0, 0, width, height);

      const topFade = height * 0.14;
      const bottomFade = height * 0.1;

      for (let i = 0; i < sparks.length; i++) {
        const s = sparks[i];
        if (advance) {
          s.y -= s.speed * dt;
          s.wobble += s.wobbleSpeed * dt;
        }

        const drawX = s.x + Math.sin(s.wobble) * 6;

        const fadeInFromBottom = s.y > height - bottomFade ? (height - s.y) / bottomFade : 1;
        const fadeOutAtTop = s.y < topFade ? Math.max(0, s.y / topFade) : 1;
        const alpha = Math.max(0, Math.min(fadeInFromBottom, fadeOutAtTop)) * 0.95;

        drawDiamond(drawX, s.y, s.size, s.color, alpha);

        if (advance && s.y < -20) sparks[i] = spawn();
      }
    }

    function tick(now: number) {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      paint(true, dt);
      raf = requestAnimationFrame(tick);
    }

    // `resize()` ya deja pintado un cuadro estatico. Si el usuario pidio
    // "reducir movimiento" (SO o navegador), las chispas quedan quietas pero
    // VISIBLES, en vez de desaparecer por completo: solo el loop continuo se
    // salta en ese caso.
    resize();
    if (!reducedMotion) raf = requestAnimationFrame(tick);

    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [reducedMotion]);

  return (
    <div className="fixed inset-0 -z-10 overflow-hidden pointer-events-none" aria-hidden>
      {/* Malla ciberpunk retro-futurista, desvanecida hacia el centro */}
      <div
        className="absolute inset-0 opacity-[0.14] [background-size:24px_24px] bg-[radial-gradient(#38bdf8_1px,transparent_1px)]"
        style={{
          maskImage: "radial-gradient(circle at 50% 40%, transparent 0%, black 78%)",
          WebkitMaskImage: "radial-gradient(circle at 50% 40%, transparent 0%, black 78%)",
        }}
      />

      {/* Orbe izquierdo: cian */}
      <motion.div
        className="absolute -left-40 top-1/3 h-[28rem] w-[28rem] rounded-full bg-cyan-500/20 blur-[120px]"
        animate={reducedMotion ? undefined : { opacity: [0.5, 0.9, 0.5], scale: [1, 1.08, 1] }}
        transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
      />

      {/* Orbe derecho: fucsia, desfasado */}
      <motion.div
        className="absolute -right-40 top-2/3 h-[28rem] w-[28rem] rounded-full bg-fuchsia-600/20 blur-[120px]"
        animate={reducedMotion ? undefined : { opacity: [0.5, 0.9, 0.5], scale: [1, 1.08, 1] }}
        transition={{ duration: 4, repeat: Infinity, ease: "easeInOut", delay: 2 }}
      />

      {/* Chispas neon, solo en los margenes laterales */}
      <canvas ref={canvasRef} className="absolute inset-0" />
    </div>
  );
}
