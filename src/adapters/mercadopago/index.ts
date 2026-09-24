import { getAdapterMode } from "../adapter-mode";
import { MercadoPagoPaymentGateway } from "./client";
import { FakePaymentGateway } from "./fake";

export type CheckoutItem = {
  title: string;
  quantity: number;
  unitPriceCents: number;
};

export type CreateCheckoutPreferenceInput = {
  orderId: string;
  orderNumber: number;
  /** Referência externa enviada ao MP (= orderId); volta em getPayment. */
  externalReference: string;
  items: CheckoutItem[];
  payerEmail?: string;
  /** Página do pedido para onde o comprador retorna após o checkout. */
  backUrl: string;
  notificationUrl?: string;
};

export type CheckoutPreference = {
  preferenceId: string;
  initPointUrl: string;
};

export type PaymentStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "refunded"
  | "cancelled"
  | "charged_back"
  | "in_mediation";

export type PaymentMethod = "pix" | "credit_card" | "boleto" | "other";

export type Payment = {
  paymentId: string;
  status: PaymentStatus;
  externalReference: string | null;
  amountCents: number;
  /** Taxa REAL cobrada pelo MP, em centavos; null quando ainda desconhecida. */
  feeCents: number | null;
  installments: number | null;
  paymentMethod: PaymentMethod;
};

export type RefundOptions = {
  /** Ausente = estorno total. Presente = parcial, deste valor. */
  amountCents?: number;
  /**
   * A chave que o vendor usa para não repetir o estorno. PRECISA ser única por
   * devolução: a chave por pagamento fazia o MP DESCARTAR EM SILÊNCIO o segundo
   * estorno parcial do mesmo pagamento — a cliente ficaria sem o dinheiro e o
   * sistema acharia que devolveu.
   */
  idempotencyKey?: string;
};

export type RefundResult = {
  /** Id do estorno no vendor (não confundir com o id do pagamento). */
  refundId: string;
  /** Como o vendor classificou o estorno: "approved", "in_process"… */
  status: string;
};

export interface PaymentGateway {
  createCheckoutPreference(
    input: CreateCheckoutPreferenceInput,
  ): Promise<CheckoutPreference>;
  getPayment(paymentId: string): Promise<Payment>;
  /**
   * Estorno. Sem `amountCents` é TOTAL; com, é parcial. Devolve o que o vendor
   * respondeu: sem o id do estorno não há como provar depois que o dinheiro
   * voltou, nem conferir no painel dele.
   */
  refundPayment(paymentId: string, options?: RefundOptions): Promise<RefundResult>;
}

let instance: PaymentGateway | undefined;

export function getPaymentGateway(): PaymentGateway {
  if (!instance) {
    instance =
      getAdapterMode() === "real"
        ? new MercadoPagoPaymentGateway()
        : new FakePaymentGateway();
  }
  return instance;
}
