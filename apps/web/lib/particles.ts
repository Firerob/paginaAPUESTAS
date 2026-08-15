/**
 * Sistema de particulas y estela del disco.
 *
 * Todo aqui es cosmetico y vive solo en el cliente: ninguna particula influye
 * en la fisica, en las colisiones ni en el marcador. Se puede borrar el
 * archivo entero y la partida seguiria siendo identica.
 *
 * Rendimiento: las particulas se dibujan con `globalCompositeOperation =
 * "lighter"` sobre gradientes radiales en vez de `shadowBlur`. El aspecto de
 * neon es el mismo y el coste es un orden de magnitud menor, que es lo que
 * permite tener cientos en pantalla sin bajar de 60 fps.
 */

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Vida restante en segundos. */
  life: number;
  maxLife: number;
  radius: number;
  color: string;
  /** Rozamiento por segundo (1 = sin rozamiento). */
  drag: number;
}

/** Punto de la estela del disco, en coordenadas de mundo. */
export interface TrailPoint {
  x: number;
  y: number;
  age: number;
}

const MAX_PARTICLES = 320;
const TRAIL_LENGTH = 18;
const TRAIL_LIFE = 0.32;

export class ParticleSystem {
  private particles: Particle[] = [];
  private trail: TrailPoint[] = [];

  get count(): number {
    return this.particles.length;
  }

  clear(): void {
    this.particles = [];
    this.trail = [];
  }

  /** Registra la posicion del disco para la estela. */
  trackPuck(x: number, y: number, speed: number): void {
    // Con el disco casi quieto la estela se ve como una mancha; se corta.
    if (speed < 60) {
      this.trail.length = 0;
      return;
    }
    this.trail.push({ x, y, age: 0 });
    if (this.trail.length > TRAIL_LENGTH) this.trail.shift();
  }

  /** Chispas de un rebote contra la banda. */
  wallImpact(x: number, y: number, nx: number, ny: number, intensity: number): void {
    const count = Math.round(6 + intensity * 10);
    for (let i = 0; i < count; i++) {
      // Cono alrededor de la normal de la pared.
      const spread = (Math.random() - 0.5) * 1.6;
      const cos = Math.cos(spread);
      const sin = Math.sin(spread);
      const dx = nx * cos - ny * sin;
      const dy = nx * sin + ny * cos;
      const speed = 120 + Math.random() * 260 * (0.4 + intensity);

      this.spawn({
        x,
        y,
        vx: dx * speed,
        vy: dy * speed,
        life: 0.25 + Math.random() * 0.3,
        maxLife: 0.55,
        radius: 2 + Math.random() * 3,
        color: "#22e8ff",
        drag: 0.06,
      });
    }
  }

  /** Destello al golpear el disco con un mazo. */
  malletHit(x: number, y: number, color: string, intensity: number): void {
    const count = Math.round(8 + intensity * 14);
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 100 + Math.random() * 320 * (0.4 + intensity);
      this.spawn({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0.2 + Math.random() * 0.35,
        maxLife: 0.55,
        radius: 2 + Math.random() * 4,
        color,
        drag: 0.08,
      });
    }
  }

  /** Explosion al anotar. */
  goalBurst(x: number, y: number, color: string): void {
    for (let i = 0; i < 90; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 80 + Math.random() * 700;
      this.spawn({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0.5 + Math.random() * 0.8,
        maxLife: 1.3,
        radius: 2 + Math.random() * 5,
        color: Math.random() < 0.35 ? "#ffcf5c" : color,
        drag: 0.04,
      });
    }
  }

  private spawn(particle: Particle): void {
    // Tope duro: una racha de rebotes no puede degradar el frame rate.
    if (this.particles.length >= MAX_PARTICLES) this.particles.shift();
    this.particles.push(particle);
  }

  update(dt: number): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        // swap-and-pop: evita reordenar el array entero en cada muerte.
        this.particles[i] = this.particles[this.particles.length - 1];
        this.particles.pop();
        continue;
      }
      const damping = Math.pow(p.drag, dt);
      p.vx *= damping;
      p.vy *= damping;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }

    for (let i = this.trail.length - 1; i >= 0; i--) {
      this.trail[i].age += dt;
      if (this.trail[i].age > TRAIL_LIFE) this.trail.splice(i, 1);
    }
  }

  /**
   * Dibuja la estela como una cinta que se afina y se apaga hacia atras.
   * `toScreen` traduce de coordenadas de mundo a pixeles.
   */
  drawTrail(
    ctx: CanvasRenderingContext2D,
    toScreen: (x: number, y: number) => { x: number; y: number },
    scale: number,
    baseRadius: number,
  ): void {
    if (this.trail.length < 2) return;

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    for (let i = 1; i < this.trail.length; i++) {
      const from = this.trail[i - 1];
      const to = this.trail[i];
      const t = i / this.trail.length;
      const fade = t * (1 - to.age / TRAIL_LIFE);
      if (fade <= 0) continue;

      const a = toScreen(from.x, from.y);
      const b = toScreen(to.x, to.y);

      ctx.strokeStyle = `rgba(34, 232, 255, ${0.5 * fade})`;
      ctx.lineWidth = baseRadius * 2 * t * scale;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();

      ctx.strokeStyle = `rgba(255, 255, 255, ${0.28 * fade})`;
      ctx.lineWidth = baseRadius * 0.9 * t * scale;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    ctx.restore();
  }

  draw(
    ctx: CanvasRenderingContext2D,
    toScreen: (x: number, y: number) => { x: number; y: number },
    scale: number,
  ): void {
    if (this.particles.length === 0) return;

    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    for (const p of this.particles) {
      const alpha = Math.max(0, p.life / p.maxLife);
      const screen = toScreen(p.x, p.y);
      const radius = p.radius * scale * (0.5 + alpha * 0.5);
      if (radius <= 0.2) continue;

      const gradient = ctx.createRadialGradient(
        screen.x,
        screen.y,
        0,
        screen.x,
        screen.y,
        radius * 2.4,
      );
      gradient.addColorStop(0, withAlpha(p.color, alpha));
      gradient.addColorStop(0.4, withAlpha(p.color, alpha * 0.45));
      gradient.addColorStop(1, withAlpha(p.color, 0));

      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, radius * 2.4, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }
}

/** #rrggbb -> rgba(). Cachea el parseo porque se llama miles de veces. */
const rgbCache = new Map<string, [number, number, number]>();

export function withAlpha(hex: string, alpha: number): string {
  let rgb = rgbCache.get(hex);
  if (!rgb) {
    const value = hex.replace("#", "");
    rgb = [
      parseInt(value.slice(0, 2), 16),
      parseInt(value.slice(2, 4), 16),
      parseInt(value.slice(4, 6), 16),
    ];
    rgbCache.set(hex, rgb);
  }
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${Math.max(0, Math.min(1, alpha))})`;
}
