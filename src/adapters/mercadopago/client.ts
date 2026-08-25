import { z } from "zod";

import type {
  CheckoutPreference,
  CreateCheckoutPreferenceInput,
  Payment,
  PaymentGateway,
  PaymentMethod,
  PaymentStatus,
} from "./index";

const MP_BASE_URL = "https://api.mercadopago.com";

// Validação TOLERANTE das respostas do MP: só os campos que consumimos,
// opcionais/defensivos onde a documentação não garante presença. Campos
// extras são ignorados (comportamento padrão do z.object no Zod 4).
const mpPreferenceResponseSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  init_point: z.url(),
});

const mpFeeDetailSchema = z.object({
  amount: z.number().nullish(),
});

const mpPaymentResponseSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  status: z.string(),
  external_reference: z.string().nullish(),
  transaction_amount: z.number().nullish(),
  installments: z.number().int().nullish(),
  payment_type_id: z.string().nullish(),
  payment_method_id: z.string().nullish(),
  fee_details: z.array(mpFeeDetailSchema).nullish(),
  transaction_details: z
    .object({ net_received_amount: z.number().nullish() })
    .nullish(),
});

const mpErrorBodySchema = z.object({
  message: z.string().nullish(),
  error: z.string().nullish(),
});

function reaisToCents(reais: number): number {
  return Math.round(reais * 100);
}

function centsToReais(cents: number): number {
  // MP espera unit_price em REAIS com 2 casas decimais.
  return Number((cents / 100).toFixed(2));
}

function mapStatus(mpStatus: string): PaymentStatus {
  switch (mpStatus) {
    case "approved":
      return "approved";
    case "pending":
    case "in_process":
      return "pending";
    case "rejected":
      return "rejected";
    case "refunded":
      return "refunded";
    case "cancelled":
      return "cancelled";
    case "charged_back":
      return "charged_back";
    case "in_mediation":
      return "in_mediation";
    default:
      // Status desconhecido é tratado como pendente: nenhuma transição de
      // pedido é disparada e a conciliação reconsulta depois.
      return "pending";
  }
}

function mapPaymentMethod(
  paymentTypeId: string | null | undefined,
  paymentMethodId: string | null | undefined,
): PaymentMethod {
  if (paymentTypeId === "credit_card") return "credit_card";
  if (paymentMethodId === "pix") return "pix";
  if (paymentMethodId === "bolbradesco" || paymentTypeId === "ticket") {
    return "boleto";
  }
  return "other";
}

/**
 * Taxa REAL do MP em centavos: soma de fee_details quando presente; senão
 * bruto − líquido (transaction_details.net_received_amount); senão null
 * (pagamento ainda sem taxa conhecida).
 */
function extractFeeCents(
  payment: z.infer<typeof mpPaymentResponseSchema>,
): number | null {
  const feeDetails = payment.fee_details ?? [];
  const amounts = feeDetails
    .map((detail) => detail.amount)
    .filter((amount): amount is number => typeof amount === "number");
  if (amounts.length > 0) {
    return reaisToCents(amounts.reduce((total, amount) => total + amount, 0));
  }
  const gross = payment.transaction_amount;
  const net = payment.transaction_details?.net_received_amount;
  if (typeof gross === "number" && typeof net === "number") {
    return reaisToCents(gross - net);
  }
  return null;
}

export class MercadoPagoPaymentGateway implements PaymentGateway {
  async createCheckoutPreference(
    input: CreateCheckoutPreferenceInput,
  ): Promise<CheckoutPreference> {
    const body = {
      external_reference: input.externalReference,
      items: input.items.map((item) => ({
        title: item.title,
        quantity: item.quantity,
        unit_price: centsToReais(item.unitPriceCents),
        currency_id: "BRL",
      })),
      ...(input.payerEmail ? { payer: { email: input.payerEmail } } : {}),
      back_urls: {
        success: input.backUrl,
        pending: input.backUrl,
        failure: input.backUrl,
      },
      auto_return: "approved",
      ...(input.notificationUrl
        ? { notification_url: input.notificationUrl }
        : {}),
      statement_descriptor: "TRIVE",
    };

    const json = await this.request("/checkout/preferences", {
      method: "POST",
      idempotencyKey: input.externalReference,
      body,
    });
    const parsed = mpPreferenceResponseSchema.parse(json);
    return { preferenceId: parsed.id, initPointUrl: parsed.init_point };
  }

  async getPayment(paymentId: string): Promise<Payment> {
    const json = await this.request(
      `/v1/payments/${encodeURIComponent(paymentId)}`,
      { method: "GET" },
    );
    const parsed = mpPaymentResponseSchema.parse(json);
    return {
      paymentId: parsed.id,
      status: mapStatus(parsed.status),
      externalReference: parsed.external_reference ?? null,
      amountCents: reaisToCents(parsed.transaction_amount ?? 0),
      feeCents: extractFeeCents(parsed),
      installments: parsed.installments ?? null,
      paymentMethod: mapPaymentMethod(
        parsed.payment_type_id,
        parsed.payment_method_id,
      ),
    };
  }

  async refundPayment(paymentId: string): Promise<void> {
    await this.request(
      `/v1/payments/${encodeURIComponent(paymentId)}/refunds`,
      {
        method: "POST",
        // Reembolso total: uma chave por pagamento evita reembolso duplicado.
        idempotencyKey: `refund:${paymentId}`,
        body: {},
      },
    );
  }

  private async request(
    path: string,
    options: {
      method: "GET" | "POST";
      body?: unknown;
      idempotencyKey?: string;
    },
  ): Promise<unknown> {
    const accessToken = process.env.MP_ACCESS_TOKEN;
    if (!accessToken) {
      throw new Error("Credenciais do Mercado Pago não configuradas");
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (options.idempotencyKey) {
      headers["X-Idempotency-Key"] = options.idempotencyKey;
    }

    const response = await fetch(`${MP_BASE_URL}${path}`, {
      method: options.method,
      headers,
      body:
        options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      // Corpo vazio ou não-JSON: tratado abaixo.
    }

    if (!response.ok) {
      const errorBody = mpErrorBodySchema.safeParse(json);
      const message = errorBody.success
        ? (errorBody.data.message ?? errorBody.data.error ?? "sem detalhes")
        : "sem detalhes";
      // Nunca inclui token nem headers na mensagem.
      throw new Error(
        `Mercado Pago respondeu HTTP ${response.status} em ${options.method} ${path}: ${message}`,
      );
    }

    return json;
  }
}
