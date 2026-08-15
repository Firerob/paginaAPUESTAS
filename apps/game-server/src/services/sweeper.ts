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
 * El umbral debe ser holgado respecto de la ventana de reconexion: una partida
 * viva late cada pocos segundos, y no queremos anular una partida real.
 */
const STALE_AFTER_SECONDS = 120;
const SWEEP_INTERVAL_MS = 30_000;

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
