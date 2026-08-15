import { FIELD_HEIGHT, FIELD_WIDTH, MALLET_RADIUS, PUCK_RADIUS } from "@ah/shared";

/**
 * Deteccion de impactos para efectos visuales y sonido.
 *
 * Se deduce del propio flujo de estado en vez de pedirle al servidor que
 * mande eventos de rebote. Dos razones:
 *
 *   1. Ancho de banda: no cuesta ni un byte extra en el cable.
 *   2. Es puramente cosmetico. Si un rebote se detecta un tick tarde o se
 *      pierde, se pierde una chispa — no un gol, no un punto, no dinero.
 *      Nada de esto influye en la partida.
 *
 * Con instantaneas a 60 Hz hay una por tick de simulacion, asi que un cambio
 * de signo en la velocidad es una señal limpia de rebote.
 */

export type ImpactKind = "wall" | "mallet";

export interface Impact {
  kind: ImpactKind;
  x: number;
  y: number;
  /** Normal de la superficie golpeada, hacia donde sale el disco. */
  nx: number;
  ny: number;
  /** 0-1, para escalar particulas y volumen. */
  intensity: number;
}

interface PuckSample {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** Por debajo de esto un cambio de signo es ruido de cuantizacion. */
const MIN_BOUNCE_SPEED = 90;
/** Cuanto tiene que crecer la rapidez para considerarlo un golpe de mazo. */
const HIT_SPEED_GAIN = 1.15;
const HIT_SPEED_FLOOR = 60;

export class ImpactDetector {
  private previous: PuckSample | null = null;

  reset(): void {
    this.previous = null;
  }

  /**
   * Compara la instantanea nueva con la anterior y devuelve los impactos
   * ocurridos entre ambas.
   */
  detect(puck: PuckSample, mallets: Array<{ x: number; y: number }>): Impact[] {
    const previous = this.previous;
    this.previous = { ...puck };
    if (!previous) return [];

    const impacts: Impact[] = [];

    const speedBefore = Math.hypot(previous.vx, previous.vy);
    const speedNow = Math.hypot(puck.vx, puck.vy);

    // --- golpe de mazo: el disco gana rapidez estando pegado a un mazo ---
    const contactRange = (MALLET_RADIUS + PUCK_RADIUS) * 1.7;
    let nearMallet = false;
    for (const mallet of mallets) {
      if (Math.hypot(puck.x - mallet.x, puck.y - mallet.y) < contactRange) {
        nearMallet = true;
        if (speedNow > speedBefore * HIT_SPEED_GAIN + HIT_SPEED_FLOOR) {
          const dx = puck.x - mallet.x;
          const dy = puck.y - mallet.y;
          const length = Math.hypot(dx, dy) || 1;
          impacts.push({
            kind: "mallet",
            x: puck.x,
            y: puck.y,
            nx: dx / length,
            ny: dy / length,
            intensity: Math.min(1, speedNow / 1500),
          });
        }
        break;
      }
    }

    // --- rebote en banda: cambio de signo cerca del borde ---
    // Se excluye la cercania a un mazo para no confundir un golpe con un
    // rebote de pared cuando ocurren en la misma esquina.
    if (!nearMallet && speedBefore > MIN_BOUNCE_SPEED) {
      const nearLeft = puck.x < PUCK_RADIUS * 3;
      const nearRight = puck.x > FIELD_WIDTH - PUCK_RADIUS * 3;
      const nearTop = puck.y < PUCK_RADIUS * 3;
      const nearBottom = puck.y > FIELD_HEIGHT - PUCK_RADIUS * 3;

      if (previous.vx < 0 && puck.vx > 0 && nearLeft) {
        impacts.push(wall(puck, 1, 0, speedBefore));
      } else if (previous.vx > 0 && puck.vx < 0 && nearRight) {
        impacts.push(wall(puck, -1, 0, speedBefore));
      }

      if (previous.vy < 0 && puck.vy > 0 && nearTop) {
        impacts.push(wall(puck, 0, 1, speedBefore));
      } else if (previous.vy > 0 && puck.vy < 0 && nearBottom) {
        impacts.push(wall(puck, 0, -1, speedBefore));
      }
    }

    return impacts;
  }
}

function wall(puck: PuckSample, nx: number, ny: number, speed: number): Impact {
  return {
    kind: "wall",
    x: puck.x,
    y: puck.y,
    nx,
    ny,
    intensity: Math.min(1, speed / 1500),
  };
}
