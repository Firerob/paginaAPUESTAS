/**
 * Confeti y monedas para la pantalla de victoria.
 *
 * Deliberadamente APARTE de `lib/particles.ts`: aquel sistema vive en
 * coordenadas de MUNDO del juego (se traduce a pantalla con `toScreen` en
 * cada fotograma, porque la mesa se desplaza/escala). Este vive directo en
 * pixeles de viewport, sobre un canvas de pantalla completa que se monta
 * solo cuando hay algo que celebrar. Mezclar los dos habria acoplado un
 * efecto cosmetico de "gane la partida" con el bucle de render del juego en
 * curso — mejor un modulo chico y desechable.
 *
 * Es 100% cosmetico: no toca el marcador, el saldo ni el resultado. Se puede
 * borrar el archivo entero y la liquidacion seguiria siendo identica.
 */

type PieceKind = "confetti" | "coin";

interface Piece {
  kind: PieceKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Radianes. */
  rotation: number;
  angularVelocity: number;
  /** Ancho para confeti, radio para moneda. */
  size: number;
  color: string;
  life: number;
  maxLife: number;
}

const GRAVITY = 950;
/** Rozamiento del aire, como fraccion de velocidad conservada por segundo. */
const DRAG_PER_SECOND = 0.88;

const PALETTE = ["#ffcf5c", "#ffe08a", "#2bffb0", "#22e8ff", "#ffffff"];
const COIN_COLOR = "#ffcf5c";

export class ConfettiSystem {
  private pieces: Piece[] = [];

  get count(): number {
    return this.pieces.length;
  }

  clear(): void {
    this.pieces = [];
  }

  /**
   * Un solo cañonazo, como el disparo por defecto de canvas-confetti: sale
   * de la parte baja del viewport hacia arriba en abanico, la gravedad hace
   * el resto. `originX` en fraccion de `width` (0.5 = centro).
   */
  burst(width: number, height: number, originX = 0.5, pieceCount = 160): void {
    const originPx = { x: width * originX, y: height * 0.92 };

    for (let i = 0; i < pieceCount; i++) {
      // Abanico amplio hacia arriba: -110° a -70° respecto del eje X.
      const angle = (-100 + (Math.random() - 0.5) * 130) * (Math.PI / 180);
      const speed = 520 + Math.random() * 620;
      const isCoin = Math.random() < 0.22;

      this.pieces.push({
        kind: isCoin ? "coin" : "confetti",
        x: originPx.x + (Math.random() - 0.5) * width * 0.18,
        y: originPx.y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        rotation: Math.random() * Math.PI * 2,
        angularVelocity: (Math.random() - 0.5) * (isCoin ? 10 : 14),
        size: isCoin ? 9 + Math.random() * 5 : 6 + Math.random() * 7,
        color: isCoin ? COIN_COLOR : PALETTE[Math.floor(Math.random() * PALETTE.length)],
        life: 2.6 + Math.random() * 1.4,
        maxLife: 4,
      });
    }
  }

  /** Lluvia continua y suave desde arriba, para sostener el ambiente. */
  drizzle(width: number, dt: number, rate = 6): void {
    const expected = rate * dt;
    const count = Math.floor(expected) + (Math.random() < expected % 1 ? 1 : 0);

    for (let i = 0; i < count; i++) {
      const isCoin = Math.random() < 0.18;
      this.pieces.push({
        kind: isCoin ? "coin" : "confetti",
        x: Math.random() * width,
        y: -20,
        vx: (Math.random() - 0.5) * 60,
        vy: 60 + Math.random() * 60,
        rotation: Math.random() * Math.PI * 2,
        angularVelocity: (Math.random() - 0.5) * 6,
        size: isCoin ? 8 + Math.random() * 4 : 5 + Math.random() * 6,
        color: isCoin ? COIN_COLOR : PALETTE[Math.floor(Math.random() * PALETTE.length)],
        life: 3.5 + Math.random() * 1.5,
        maxLife: 5,
      });
    }
  }

  update(dt: number, height: number): void {
    const damping = Math.pow(DRAG_PER_SECOND, dt);

    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const p = this.pieces[i];
      p.life -= dt;
      // Tambien se descarta si cae fuera de la pantalla, para no acumular
      // piezas invisibles indefinidamente en una celebracion larga.
      if (p.life <= 0 || p.y > height + 40) {
        this.pieces[i] = this.pieces[this.pieces.length - 1];
        this.pieces.pop();
        continue;
      }

      p.vy += GRAVITY * dt;
      p.vx *= damping;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rotation += p.angularVelocity * dt;
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    for (const p of this.pieces) {
      const fadeIn = Math.min(1, (p.maxLife - p.life) * 6);
      const fadeOut = Math.min(1, p.life / 0.6);
      const alpha = Math.min(fadeIn, fadeOut);
      if (alpha <= 0.02) continue;

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);

      if (p.kind === "coin") {
        drawCoin(ctx, p.size);
      } else {
        drawConfettiPiece(ctx, p.size, p.color);
      }

      ctx.restore();
    }
  }
}

/** Rectangulo con brillo, como una tira de papel picado. */
function drawConfettiPiece(ctx: CanvasRenderingContext2D, size: number, color: string): void {
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = size * 0.8;
  ctx.fillRect(-size / 2, -size * 0.35, size, size * 0.7);
}

/** Disco dorado con reborde y un brillo diagonal, como una moneda de casino. */
function drawCoin(ctx: CanvasRenderingContext2D, radius: number): void {
  ctx.shadowColor = COIN_COLOR;
  ctx.shadowBlur = radius * 1.4;

  ctx.fillStyle = "#a6791f";
  ctx.beginPath();
  ctx.ellipse(0, radius * 0.08, radius, radius * 0.92, 0, 0, Math.PI * 2);
  ctx.fill();

  const body = ctx.createLinearGradient(-radius, -radius, radius, radius);
  body.addColorStop(0, "#fff3c4");
  body.addColorStop(0.5, COIN_COLOR);
  body.addColorStop(1, "#c98f2a");
  ctx.fillStyle = body;
  ctx.shadowBlur = radius * 0.6;
  ctx.beginPath();
  ctx.ellipse(0, 0, radius, radius * 0.92, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
  ctx.lineWidth = Math.max(1, radius * 0.12);
  ctx.beginPath();
  ctx.ellipse(0, 0, radius * 0.62, radius * 0.56, 0, 0, Math.PI * 2);
  ctx.stroke();
}
