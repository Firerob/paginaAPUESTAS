import { findStaleMatches } from "./match.service";
import { voidMatch } from "./wallet.service";

/**
 * Red de seguridad para el dinero.
 *
 * Si el proceso del game server muere con partidas en curso, ese saldo queda
 * bloqueado para siempre a menos que alguien lo libere. El sweeper busca
 * partidas sin latido y las anula, devolviendo la apuesta intacta.
 *
 * Que el jugador pierda una partida por un crash NUESTRO seria inaceptable,
 * asi que la resolucion es siempre devolucion, nunca derrota.
 *
 * El umbral debe ser holgado respecto del latido normal (`HEARTBEAT_MS` en
 * BaseMatchRoom, 10s, y cada jugada tambien lo refresca via `updateScore`):
 * no queremos anular una partida real por un socket lento. Pero OJO — esto
 * NO es la ventana de reconexion de un jugador (`RECONNECT_WINDOW_S`, 15s):
 * el latido sigue avanzando mientras el PROCESO este vivo, sin importar si
 * un jugador puntual se cayo. Este umbral mide si el proceso entero murio.
 *
 * Mientras una partida sigue "stale" sin barrer, `MatchManager.hasOpenMatch`
 * bloquea a esos dos usuarios de arrancar cualquier partida nueva (el indice
 * parcial de `match_players` no distingue "partida viva" de "huerfana"). Por
 * eso el umbral se mantiene lo mas chico posible sin arriesgar falsos
 * positivos: cada segundo de mas aca es un jugador real bloqueado de jugar
 * por un crash o un redeploy que no fue culpa suya.
 */
const STALE_AFTER_SECONDS = 45;
const SWEEP_INTERVAL_MS = 10_000;

let timer: NodeJS.Timeout | null = null;

async function sweepOnce(): Promise<void> {
  const stale = await findStaleMatches(STALE_AFTER_SECONDS);
  for (const matchId of stale) {
    try {
      const result = await voidMatch({ matchId, reason: "error" });
      if (!result.alreadySettled) {
        console.warn(
          `[sweeper] partida ${matchId} anulada por servidor caido, devueltos ${result.refunded} COP`,
        );
      }
    } catch (error) {
      console.error(`[sweeper] no se pudo anular ${matchId}`, error);
    }
  }
}

export function startSweeper(): void {
  if (timer) return;
  void sweepOnce().catch((e) => console.error("[sweeper] fallo el barrido inicial", e));
  timer = setInterval(() => {
    void sweepOnce().catch((e) => console.error("[sweeper] fallo el barrido", e));
  }, SWEEP_INTERVAL_MS);
  timer.unref();
}

export function stopSweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
