import { getAdapterMode } from "../adapter-mode";
import { MercadoPagoPaymentGateway } from "./client";
import { FakePaymentGateway } from "./fake";

export type CheckoutItem = {
  title: string;
  quantity: number;
  unitPriceCents: number;
};

export type CheckoutOrder = {
  orderId: string;
  items: CheckoutItem[];
  payerEmail?: string;
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
  | "cancelled";

export type Payment = {
  paymentId: string;
  status: PaymentStatus;
  orderId?: string;
  amountCents: number;
  feeCents?: number;
  installments?: number;
};

export interface PaymentGateway {
  createCheckoutPreference(order: CheckoutOrder): Promise<CheckoutPreference>;
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
