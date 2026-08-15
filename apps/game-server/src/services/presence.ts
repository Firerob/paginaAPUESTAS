/**
 * Contador de conexiones vivas. En memoria, no en base de datos: es una
 * metrica de ambiente para el lobby ("jugadores conectados"), no un dato
 * contable que necesite sobrevivir un reinicio o replicarse entre procesos.
 *
 * Si el game server alguna vez corre en mas de una instancia, esto deja de
 * ser exacto (cada proceso cuenta solo sus propios sockets) y habria que
 * mover el conteo a algo compartido (Redis). No vale la pena hoy.
 */
let connected = 0;

export function markConnected(): void {
  connected++;
}

export function markDisconnected(): void {
  connected = Math.max(0, connected - 1);
}

export function connectedCount(): number {
  return connected;
}
