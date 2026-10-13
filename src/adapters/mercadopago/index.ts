import { getAdapterMode } from "../adapter-mode";
import { MercadoPagoPaymentGateway } from "./client";
import { FakePaymentGateway } from "./fake";

export type CheckoutItem = {
  title: string;
  quantity: number;
  unitPriceCents: number;
};

/**
 * Quem está comprando, como o antifraude do MP precisa ver.
 *
 * Mandar só o e-mail (ou nada) faz a compra parecer anônima e o MP recusa com
 * `cc_rejected_high_risk`: em 09-10/2026, 7 de 9 tentativas de cartão pelo
 * site foram recusadas assim, enquanto os links feitos à mão no app do MP —
 * que levam e-mail e CPF — aprovaram 3 de 3. Todo campo que a loja tiver vai;
 * o que faltar é OMITIDO (campo vazio o MP recusa, não ignora).
 */
export type CheckoutPayer = {
  firstName: string;
  lastName: string;
  email?: string;
  document?: { type: "CPF" | "CNPJ"; number: string };
  phone?: { areaCode: string; number: string };
  address?: { zipCode: string; streetName: string; streetNumber: string };
};

export type CreateCheckoutPreferenceInput = {
  orderId: string;
  orderNumber: number;
  /** Referência externa enviada ao MP (= orderId); volta em getPayment. */
  externalReference: string;
  items: CheckoutItem[];
  payer?: CheckoutPayer;
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
