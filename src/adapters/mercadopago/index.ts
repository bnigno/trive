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

export interface PaymentGateway {
  createCheckoutPreference(
    input: CreateCheckoutPreferenceInput,
  ): Promise<CheckoutPreference>;
  getPayment(paymentId: string): Promise<Payment>;
  refundPayment(paymentId: string): Promise<void>;
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
