import {
  FIELD_HEIGHT,
  FIELD_WIDTH,
  GOAL_HALF_WIDTH,
  MALLET_RADIUS,
  PUCK_RADIUS,
  type RenderState,
  type Seat,
} from "@ah/shared";
import { NEON, seatColor, seatGlow } from "./theme";
import { ParticleSystem, withAlpha } from "./particles";

/**
 * Capa de dibujo. Ni una sola decision de juego vive aqui: recibe un estado ya
 * resuelto por el servidor y lo pinta.
 *
 * ---------------------------------------------------------------------------
 * Estrategia de rendimiento
 * ---------------------------------------------------------------------------
 * El aspecto neon se consigue con `shadowBlur`, que es la operacion mas cara
 * del Canvas 2D: obliga a rasterizar la forma aparte y desenfocarla. Pagarlo
 * 60 veces por segundo por cada elemento hundiria el frame rate — justo lo que
 * acabamos de arreglar en el netcode.
 *
 * Por eso el dibujo esta en dos capas:
 *
 *   ESTATICA   mesa, bordes, arcos, rejilla, circulo central. Se dibuja UNA
 *              vez a un canvas offscreen con todo el brillo que haga falta, y
 *              luego solo se copia. Se regenera al cambiar de tamaño.
 *   DINAMICA   disco, mazos, particulas, luces de gol. Usa composicion
 *              "lighter" sobre gradientes radiales, que da el mismo aspecto a
 *              una fraccion del coste, y reserva `shadowBlur` para el disco y
 *              los mazos: tres elementos, no treinta.
 */

export interface View {
  scale: number;
  offsetX: number;
  offsetY: number;
  /**
   * Rotacion de 180 grados de la mesa. El asiento 1 defiende y=0 en
   * coordenadas de mundo, pero todo jugador espera defender la parte de abajo
   * de SU pantalla. Es solo presentacion: las coordenadas que se envian al
   * servidor se des-rotan antes.
   */
  flip: boolean;
  cssWidth: number;
  cssHeight: number;
}

export function computeView(cssWidth: number, cssHeight: number, flip: boolean): View {
  // Margen para que el resplandor de los bordes no quede cortado.
  const scale = Math.min((cssWidth * 0.94) / FIELD_WIDTH, (cssHeight * 0.94) / FIELD_HEIGHT);
  return {
    scale,
    offsetX: (cssWidth - FIELD_WIDTH * scale) / 2,
    offsetY: (cssHeight - FIELD_HEIGHT * scale) / 2,
    flip,
    cssWidth,
    cssHeight,
  };
}

export function worldToScreen(view: View, x: number, y: number): { x: number; y: number } {
  const wx = view.flip ? FIELD_WIDTH - x : x;
  const wy = view.flip ? FIELD_HEIGHT - y : y;
  return { x: view.offsetX + wx * view.scale, y: view.offsetY + wy * view.scale };
}

/** Inversa exacta de worldToScreen. Es la que traduce el puntero a intencion. */
export function screenToWorld(view: View, sx: number, sy: number): { x: number; y: number } {
  const wx = (sx - view.offsetX) / view.scale;
  const wy = (sy - view.offsetY) / view.scale;
  return {
    x: view.flip ? FIELD_WIDTH - wx : wx,
    y: view.flip ? FIELD_HEIGHT - wy : wy,
  };
}

export interface DrawOptions {
  state: RenderState;
  mySeat: Seat;
  /** Posicion predicha del mazo propio. Cosmetica: manda el servidor. */
  myMallet: { x: number; y: number };
  opponentConnected: boolean;
  opponentReconnectMs: number;
}

/** Efectos que decaen con el tiempo. Puro adorno. */
interface Effects {
  flashColor: string;
  flashStrength: number;
  /** Sacudida de camara en pixeles. */
  shake: number;
  /** Encendido de cada arco: indice 0 = arco de arriba, 1 = el de abajo. */
  goalGlow: [number, number];
}

export class Renderer {
  private view: View = computeView(1, 1, false);
  private staticLayer: HTMLCanvasElement | null = null;
  private staticKey = "";

  readonly particles = new ParticleSystem();

  private effects: Effects = {
    flashColor: NEON.gold,
    flashStrength: 0,
    shake: 0,
    goalGlow: [0, 0],
  };

  /** Milisegundos que costo dibujar el ultimo fotograma. */
  lastFrameMs = 0;

  setView(view: View): void {
    this.view = view;
  }

  getView(): View {
    return this.view;
  }

  /** Dispara el festejo de gol. `attackedGoal` es el arco donde entro. */
  celebrateGoal(attackedGoal: 0 | 1, color: string): void {
    this.effects.flashColor = color;
    this.effects.flashStrength = 1;
    this.effects.shake = 16;
    this.effects.goalGlow[attackedGoal] = 1;
    this.particles.goalBurst(FIELD_WIDTH / 2, attackedGoal === 0 ? 0 : FIELD_HEIGHT, color);
  }

  /** Sacudida corta, para impactos fuertes. */
  bump(strength: number): void {
    this.effects.shake = Math.max(this.effects.shake, strength);
  }

  reset(): void {
    this.particles.clear();
    this.effects = { flashColor: NEON.gold, flashStrength: 0, shake: 0, goalGlow: [0, 0] };
  }

  draw(ctx: CanvasRenderingContext2D, dt: number, opts: DrawOptions): void {
    const started = performance.now();
    const view = this.view;

    this.particles.update(dt);
    this.decayEffects(dt);

    ctx.save();

    // Sacudida de camara: traslacion global, para que arrastre todo, mesa
    // incluida.
    if (this.effects.shake > 0.2) {
      const magnitude = this.effects.shake;
      ctx.translate((Math.random() - 0.5) * magnitude, (Math.random() - 0.5) * magnitude);
    }

    this.drawBackground(ctx, view);
    this.drawStaticLayer(ctx, view);
    this.drawGoalLights(ctx, view);

    const toScreen = (x: number, y: number) => worldToScreen(view, x, y);
    this.particles.drawTrail(ctx, toScreen, view.scale, PUCK_RADIUS);

    const opponentSeat: Seat = opts.mySeat === 0 ? 1 : 0;
    this.drawMallet(
      ctx,
      opts.state.mallets[opponentSeat],
      seatColor(opponentSeat, opts.mySeat),
      seatGlow(opponentSeat, opts.mySeat),
      !opts.opponentConnected,
    );
    this.drawMallet(
      ctx,
      opts.myMallet,
      seatColor(opts.mySeat, opts.mySeat),
      seatGlow(opts.mySeat, opts.mySeat),
      false,
    );

    this.drawPuck(ctx, opts.state.puck);
    this.particles.draw(ctx, toScreen, view.scale);

    ctx.restore();

    this.drawFlash(ctx, view);

    this.lastFrameMs = performance.now() - started;
  }

  private decayEffects(dt: number): void {
    const e = this.effects;
    e.flashStrength = Math.max(0, e.flashStrength - dt * 2.2);
    e.shake = Math.max(0, e.shake - dt * 42);
    e.goalGlow[0] = Math.max(0, e.goalGlow[0] - dt * 0.75);
    e.goalGlow[1] = Math.max(0, e.goalGlow[1] - dt * 0.75);
  }

  // -------------------------------------------------------------------------
  // Fondo y capa estatica
  // -------------------------------------------------------------------------

  private drawBackground(ctx: CanvasRenderingContext2D, view: View): void {
    // Se pinta mas grande que el viewport para que la sacudida no descubra
    // bordes sin pintar.
    ctx.fillStyle = NEON.void;
    ctx.fillRect(-40, -40, view.cssWidth + 80, view.cssHeight + 80);

    const center = worldToScreen(view, FIELD_WIDTH / 2, FIELD_HEIGHT / 2);
    const radius = Math.max(view.cssWidth, view.cssHeight) * 0.7;
    const halo = ctx.createRadialGradient(center.x, center.y, 0, center.x, center.y, radius);
    halo.addColorStop(0, "rgba(28, 60, 140, 0.30)");
    halo.addColorStop(0.55, "rgba(12, 22, 60, 0.16)");
    halo.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = halo;
    ctx.fillRect(-40, -40, view.cssWidth + 80, view.cssHeight + 80);
  }

  /**
   * Copia la mesa ya renderizada. Se regenera solo si cambio el tamaño o la
   * orientacion — es decir, casi nunca.
   */
  private drawStaticLayer(ctx: CanvasRenderingContext2D, view: View): void {
    const key = `${Math.round(view.cssWidth)}x${Math.round(view.cssHeight)}:${view.flip ? 1 : 0}`;
    if (!this.staticLayer || this.staticKey !== key) {
      this.staticLayer = this.buildStaticLayer(view);
      this.staticKey = key;
    }
    if (this.staticLayer) {
      ctx.drawImage(this.staticLayer, 0, 0, view.cssWidth, view.cssHeight);
    }
  }

  private buildStaticLayer(view: View): HTMLCanvasElement | null {
    if (typeof document === "undefined" || view.cssWidth < 2) return null;

    const dpr = window.devicePixelRatio || 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(view.cssWidth * dpr));
    canvas.height = Math.max(1, Math.round(view.cssHeight * dpr));

    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.scale(dpr, dpr);

    const topLeft = worldToScreen(view, 0, 0);
    const bottomRight = worldToScreen(view, FIELD_WIDTH, FIELD_HEIGHT);
    const x = Math.min(topLeft.x, bottomRight.x);
    const y = Math.min(topLeft.y, bottomRight.y);
    const w = Math.abs(bottomRight.x - topLeft.x);
    const h = Math.abs(bottomRight.y - topLeft.y);
    const radius = 22 * view.scale;

    // --- superficie de cristal oscuro ---
    const surface = ctx.createLinearGradient(x, y, x, y + h);
    surface.addColorStop(0, NEON.glassTop);
    surface.addColorStop(0.5, NEON.glassBottom);
    surface.addColorStop(1, NEON.glassTop);
    roundRect(ctx, x, y, w, h, radius);
    ctx.fillStyle = surface;
    ctx.fill();

    // Reflejo diagonal, como cristal pulido.
    const sheen = ctx.createLinearGradient(x, y, x + w, y + h);
    sheen.addColorStop(0, "rgba(255,255,255,0.055)");
    sheen.addColorStop(0.45, "rgba(255,255,255,0.012)");
    sheen.addColorStop(1, "rgba(255,255,255,0.045)");
    roundRect(ctx, x, y, w, h, radius);
    ctx.fillStyle = sheen;
    ctx.fill();

    // --- rejilla ciberpunk ---
    ctx.save();
    roundRect(ctx, x, y, w, h, radius);
    ctx.clip();
    ctx.strokeStyle = withAlpha(NEON.grid, 0.5);
    ctx.lineWidth = 1;
    const cell = 50 * view.scale;
    for (let gx = x; gx <= x + w; gx += cell) {
      ctx.beginPath();
      ctx.moveTo(gx, y);
      ctx.lineTo(gx, y + h);
      ctx.stroke();
    }
    for (let gy = y; gy <= y + h; gy += cell) {
      ctx.beginPath();
      ctx.moveTo(x, gy);
      ctx.lineTo(x + w, gy);
      ctx.stroke();
    }
    ctx.restore();

    // --- borde neon (aqui si vale la pena shadowBlur: se paga una vez) ---
    ctx.save();
    ctx.shadowColor = NEON.cyan;
    ctx.shadowBlur = 26 * view.scale;
    ctx.strokeStyle = withAlpha(NEON.cyan, 0.85);
    ctx.lineWidth = Math.max(2, 3.5 * view.scale);
    roundRect(ctx, x, y, w, h, radius);
    ctx.stroke();
    ctx.shadowBlur = 10 * view.scale;
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.lineWidth = Math.max(1, 1.2 * view.scale);
    roundRect(ctx, x, y, w, h, radius);
    ctx.stroke();
    ctx.restore();

    // --- linea de medio campo y circulo central ---
    const midLeft = worldToScreen(view, 0, FIELD_HEIGHT / 2);
    const midRight = worldToScreen(view, FIELD_WIDTH, FIELD_HEIGHT / 2);
    ctx.save();
    ctx.shadowColor = NEON.cyan;
    ctx.shadowBlur = 14 * view.scale;
    ctx.strokeStyle = withAlpha(NEON.cyan, 0.55);
    ctx.lineWidth = Math.max(1.5, 2 * view.scale);
    ctx.setLineDash([14 * view.scale, 10 * view.scale]);
    ctx.beginPath();
    ctx.moveTo(midLeft.x, midLeft.y);
    ctx.lineTo(midRight.x, midRight.y);
    ctx.stroke();
    ctx.setLineDash([]);

    const center = worldToScreen(view, FIELD_WIDTH / 2, FIELD_HEIGHT / 2);
    ctx.strokeStyle = withAlpha(NEON.cyan, 0.5);
    ctx.lineWidth = Math.max(1.5, 2 * view.scale);
    ctx.beginPath();
    ctx.arc(center.x, center.y, 78 * view.scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = withAlpha(NEON.cyan, 0.22);
    ctx.lineWidth = Math.max(1, 1.2 * view.scale);
    ctx.beginPath();
    ctx.arc(center.x, center.y, 96 * view.scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // --- arcos, en dorado ---
    for (const goalY of [0, FIELD_HEIGHT]) {
      const a = worldToScreen(view, FIELD_WIDTH / 2 - GOAL_HALF_WIDTH, goalY);
      const b = worldToScreen(view, FIELD_WIDTH / 2 + GOAL_HALF_WIDTH, goalY);
      const depth = 26 * view.scale * (a.y < view.cssHeight / 2 ? 1 : -1);

      const mouth = ctx.createLinearGradient(a.x, a.y, a.x, a.y + depth);
      mouth.addColorStop(0, withAlpha(NEON.gold, 0.3));
      mouth.addColorStop(1, withAlpha(NEON.gold, 0));
      ctx.fillStyle = mouth;
      ctx.fillRect(
        Math.min(a.x, b.x),
        Math.min(a.y, a.y + depth),
        Math.abs(b.x - a.x),
        Math.abs(depth),
      );

      ctx.save();
      ctx.shadowColor = NEON.gold;
      ctx.shadowBlur = 22 * view.scale;
      ctx.strokeStyle = NEON.gold;
      ctx.lineWidth = Math.max(3, 5 * view.scale);
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();

      for (const post of [a, b]) {
        ctx.shadowBlur = 16 * view.scale;
        ctx.fillStyle = "#fff3d0";
        ctx.beginPath();
        ctx.arc(post.x, post.y, Math.max(2.5, 4 * view.scale), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    return canvas;
  }

  // -------------------------------------------------------------------------
  // Capa dinamica
  // -------------------------------------------------------------------------

  /** Los arcos se encienden al recibir un gol y se van apagando. */
  private drawGoalLights(ctx: CanvasRenderingContext2D, view: View): void {
    const glows = this.effects.goalGlow;
    if (glows[0] <= 0.01 && glows[1] <= 0.01) return;

    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    for (const goal of [0, 1] as const) {
      const strength = glows[goal];
      if (strength <= 0.01) continue;

      const center = worldToScreen(view, FIELD_WIDTH / 2, goal === 0 ? 0 : FIELD_HEIGHT);
      const radius = GOAL_HALF_WIDTH * 2.4 * view.scale;

      const light = ctx.createRadialGradient(center.x, center.y, 0, center.x, center.y, radius);
      light.addColorStop(0, withAlpha(NEON.gold, 0.75 * strength));
      light.addColorStop(0.4, withAlpha(NEON.gold, 0.3 * strength));
      light.addColorStop(1, withAlpha(NEON.gold, 0));
      ctx.fillStyle = light;
      ctx.beginPath();
      ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  private drawMallet(
    ctx: CanvasRenderingContext2D,
    pos: { x: number; y: number },
    color: string,
    glow: string,
    dimmed: boolean,
  ): void {
    const view = this.view;
    const screen = worldToScreen(view, pos.x, pos.y);
    const radius = MALLET_RADIUS * view.scale;
    const alpha = dimmed ? 0.3 : 1;

    // Aura barata: gradiente radial en modo "lighter", sin shadowBlur.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const aura = ctx.createRadialGradient(
      screen.x,
      screen.y,
      radius * 0.4,
      screen.x,
      screen.y,
      radius * 2.2,
    );
    aura.addColorStop(0, withAlpha(color, 0.4 * alpha));
    aura.addColorStop(1, withAlpha(color, 0));
    ctx.fillStyle = aura;
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, radius * 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = alpha;

    const body = ctx.createRadialGradient(
      screen.x - radius * 0.3,
      screen.y - radius * 0.35,
      radius * 0.1,
      screen.x,
      screen.y,
      radius,
    );
    body.addColorStop(0, "#f4fbff");
    body.addColorStop(0.35, color);
    body.addColorStop(1, withAlpha(color, 0.35));
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
    ctx.fill();

    // Anillo neon: uno de los pocos shadowBlur del bucle vivo.
    ctx.shadowColor = glow;
    ctx.shadowBlur = 18 * view.scale;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.5, 2.5 * view.scale);
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, radius * 0.94, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Hueco central oscuro, como un mazo real visto desde arriba.
    ctx.fillStyle = "rgba(4, 8, 22, 0.72)";
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, radius * 0.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = withAlpha(color, 0.9);
    ctx.lineWidth = Math.max(1, 1.5 * view.scale);
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, radius * 0.5, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();
  }

  private drawPuck(
    ctx: CanvasRenderingContext2D,
    puck: { x: number; y: number; vx: number; vy: number },
  ): void {
    const view = this.view;
    const screen = worldToScreen(view, puck.x, puck.y);
    const radius = PUCK_RADIUS * view.scale;
    // Cuanto mas rapido va, mas caliente se ve.
    const heat = Math.min(1, Math.hypot(puck.vx, puck.vy) / 1400);
    const auraRadius = radius * (3 + heat * 2);

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const aura = ctx.createRadialGradient(screen.x, screen.y, 0, screen.x, screen.y, auraRadius);
    aura.addColorStop(0, withAlpha(NEON.cyan, 0.55 + heat * 0.35));
    aura.addColorStop(0.35, withAlpha(NEON.cyan, 0.22));
    aura.addColorStop(1, withAlpha(NEON.cyan, 0));
    ctx.fillStyle = aura;
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, auraRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.shadowColor = NEON.cyan;
    ctx.shadowBlur = (14 + heat * 20) * view.scale;
    ctx.fillStyle = NEON.puck;
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.strokeStyle = withAlpha(NEON.cyan, 0.95);
    ctx.lineWidth = Math.max(1, 1.6 * view.scale);
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, radius * 0.62, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /** Destello a pantalla completa al anotar. */
  private drawFlash(ctx: CanvasRenderingContext2D, view: View): void {
    const strength = this.effects.flashStrength;
    if (strength <= 0.01) return;

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = withAlpha(this.effects.flashColor, 0.28 * strength);
    ctx.fillRect(0, 0, view.cssWidth, view.cssHeight);
    ctx.restore();
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}
