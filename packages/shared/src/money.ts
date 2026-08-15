/**
 * Dinero.
 *
 * Todos los montos son ENTEROS en pesos colombianos. Nunca float: un float
 * en la contabilidad es una fuga de dinero esperando a ocurrir. En Postgres
 * viven como BIGINT; en JS caben de sobra en Number.MAX_SAFE_INTEGER
 * (9.007e15 COP), pero la capa de acceso a datos los parsea explicitamente.
 */

export const CURRENCY = "COP" as const;

/** 10000 bps = 100%. 1000 bps = 10%. */
export type BasisPoints = number;

export interface Settlement {
  /** Suma apostada por ambos jugadores. */
  pot: number;
  /** Comision de la plataforma. */
  rake: number;
  /** Monto acreditado al ganador (incluye su propia apuesta de vuelta). */
  payout: number;
}

/**
 * Calcula la liquidacion de una partida 1v1.
 *
 * El rake se redondea hacia abajo, de modo que el redondeo siempre favorece
 * al jugador y nunca a la casa: pot - rake >= pot * (1 - bps/10000).
 * Invariante que se verifica en tests: payout + rake === pot, exacto.
 */
export function computeSettlement(stake: number, rakeBps: BasisPoints): Settlement {
  if (!Number.isInteger(stake) || stake <= 0) {
    throw new Error(`stake invalido: ${stake}`);
  }
  if (!Number.isInteger(rakeBps) || rakeBps < 0 || rakeBps > 10000) {
    throw new Error(`rakeBps invalido: ${rakeBps}`);
  }
  const pot = stake * 2;
  const rake = Math.floor((pot * rakeBps) / 10000);
  return { pot, rake, payout: pot - rake };
}

/** Formato de presentacion. No usar para calcular nada. */
export function formatCOP(amount: number): string {
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(amount);
}
