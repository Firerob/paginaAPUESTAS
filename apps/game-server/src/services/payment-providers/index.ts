import { env } from "../../config/env";
import { mockProvider } from "./mock";
import type { PaymentProvider } from "./provider";

export * from "./provider";

/**
 * Punto unico donde se elige la pasarela real.
 *
 * En produccion no hay adaptador mock disponible: si `PAYMENT_PROVIDER` no
 * esta configurado con un PSP real, el servidor rechaza arrancar el cajero
 * en vez de aceptar depositos que nadie pago de verdad. Cuando se integre un
 * PSP (Wompi, ePayco, PayU...), su adaptador se agrega aqui.
 */
export function getPaymentProvider(): PaymentProvider {
  if (!env.isProd) return mockProvider;

  throw new Error(
    "No hay una pasarela de pago real configurada para produccion. " +
      "Implementa un PaymentProvider (Wompi/ePayco/PayU) y registralo en " +
      "getPaymentProvider() antes de aceptar dinero real.",
  );
}
