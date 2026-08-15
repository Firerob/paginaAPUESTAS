/**
 * Contrato de una pasarela de pago.
 *
 * El servicio de cajero (cashier.service.ts) nunca habla con Nequi, DaviPlata,
 * PSE o una franquicia de tarjeta directamente: siempre pasa por esta
 * interfaz. Eso es lo que permite tener un adaptador de desarrollo (mock.ts)
 * que aprueba todo al instante, y mas adelante un adaptador real (Wompi,
 * ePayco, PayU son los PSP mas comunes en Colombia para Nequi/PSE/DaviPlata)
 * sin tocar una linea de la logica de saldo.
 *
 * Cualquier adaptador real que se agregue tiene que:
 *   1. Verificar la firma/secreto del webhook antes de confiar en el.
 *   2. Ser idempotente: el mismo evento puede llegar dos veces.
 *   3. Nunca marcar un deposito como completado sin esa verificacion.
 */

export type PaymentMethod = "NEQUI" | "DAVIPLATA" | "PSE" | "CARD";

export interface DepositIntent {
  /** Referencia del lado de la pasarela. Se guarda para conciliar. */
  providerRef: string;
  /** Si el flujo requiere salir del sitio (PSE, tarjeta con 3DS). */
  redirectUrl?: string;
  /** Instrucciones para flujos push (p.ej. "Aprueba en la app de Nequi"). */
  instructions?: string;
  /**
   * true si la pasarela ya confirmo el pago en esta misma llamada (solo
   * pasa con el adaptador mock; un PSP real siempre resuelve por webhook).
   */
  settledImmediately: boolean;
}

export interface WithdrawalIntent {
  providerRef: string;
  settledImmediately: boolean;
}

export interface PaymentProvider {
  readonly name: string;

  createDeposit(params: {
    transactionId: string;
    userId: string;
    amount: number;
    method: PaymentMethod;
  }): Promise<DepositIntent>;

  createWithdrawal(params: {
    transactionId: string;
    userId: string;
    amount: number;
    method: PaymentMethod;
    destination: Record<string, unknown>;
  }): Promise<WithdrawalIntent>;
}
