import { z } from "zod";
import type { CheckoutOrder, CheckoutPreference, Payment, PaymentGateway } from "./index";

// Esboço da validação das respostas do Mercado Pago (só os campos que consumimos).
// Confirmar contra a documentação oficial ao implementar na Fase 3.
export const mpPreferenceResponseSchema = z.object({
  id: z.string(),
  init_point: z.url(),
});

export const mpPaymentResponseSchema = z.object({
  id: z.union([z.number(), z.string()]),
  status: z.string(),
  external_reference: z.string().optional(),
  transaction_amount: z.number(),
  installments: z.number().int().optional(),
});

export class MercadoPagoPaymentGateway implements PaymentGateway {
  // Fase 3: fetch autenticado com MP_ACCESS_TOKEN, parse com os schemas acima,
  // conversão de valores decimais (BRL) para inteiros em centavos na borda.

  async createCheckoutPreference(_order: CheckoutOrder): Promise<CheckoutPreference> {
    throw new Error("Adapter real do Mercado Pago entra na Fase 3");
  }

  async getPayment(_paymentId: string): Promise<Payment> {
    throw new Error("Adapter real do Mercado Pago entra na Fase 3");
  }

  async refundPayment(_paymentId: string): Promise<void> {
    throw new Error("Adapter real do Mercado Pago entra na Fase 3");
  }
}
