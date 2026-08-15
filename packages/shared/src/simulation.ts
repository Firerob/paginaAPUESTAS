import { MALLET_MAX_SPEED } from "./constants";

/**
 * Un paso de mazo hacia su objetivo, acotado por la velocidad maxima.
 *
 * Esta funcion vive en el paquete compartido porque el servidor y el cliente
 * TIENEN que calcularla igual, bit a bit:
 *
 *   - el servidor la usa en `integrateMallet` para mover el mazo de verdad
 *   - el cliente la usa para predecir su propio mazo y para rehacer los inputs
 *     pendientes durante la reconciliacion
 *
 * Si las dos versiones divergieran aunque sea un poco, la reconciliacion
 * encontraria un error en cada instantanea y el mazo del jugador vibraria de
 * forma permanente. Tenerla escrita una sola vez elimina esa clase de bug de
 * raiz, en vez de confiar en que dos copias se mantengan sincronizadas.
 *
 * Que el cliente comparta ESTA funcion no debilita el modelo
 * server-authoritative: es cinematica de un objeto que el propio jugador
 * controla, no fisica del disco, ni colisiones, ni goles. El servidor sigue
 * siendo el unico que decide donde termina realmente el mazo.
 */
export function stepMalletToward(
  pos: { x: number; y: number },
  target: { x: number; y: number },
  dt: number,
): void {
  const dx = target.x - pos.x;
  const dy = target.y - pos.y;
  const distance = Math.hypot(dx, dy);
  const maxStep = MALLET_MAX_SPEED * dt;

  if (distance <= maxStep || distance === 0) {
    pos.x = target.x;
    pos.y = target.y;
    return;
  }

  const scale = maxStep / distance;
  pos.x += dx * scale;
  pos.y += dy * scale;
}
