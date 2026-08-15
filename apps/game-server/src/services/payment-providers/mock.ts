import type { PaymentProvider } from "./provider";

/**
 * Adaptador de desarrollo. Aprueba cualquier deposito o retiro al instante,
 * sin tocar una pasarela real. Sirve para desarrollar y probar el Cajero de
 * punta a punta sin credenciales de un PSP.
 *
 * NUNCA se usa en produccion (ver getPaymentProvider en index.ts): un
 * adaptador que aprueba pagos sin verificar nada es, en produccion, una
 * maquina de imprimir dinero.
 */
export const mockProvider: PaymentProvider = {
  name: "mock",

  async createDeposit({ transactionId, method }) {
    return {
      providerRef: `mock_dep_${transactionId}`,
      instructions:
        method === "PSE"
          ? "Simulado: en un PSP real serias redirigido a tu banco."
          : `Simulado: en un PSP real recibirias un push en tu app de ${method}.`,
      settledImmediately: true,
    };
  },

  async createWithdrawal({ transactionId }) {
    return {
      providerRef: `mock_wd_${transactionId}`,
      settledImmediately: true,
    };
  },
};
