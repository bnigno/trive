import type {
  CheckoutOrder,
  CheckoutPreference,
  Payment,
  PaymentGateway,
} from "./index";

export class FakePaymentGateway implements PaymentGateway {
  private readonly payments = new Map<string, Payment>();
  private sequence = 0;

  async createCheckoutPreference(order: CheckoutOrder): Promise<CheckoutPreference> {
    this.sequence += 1;
    const preferenceId = `fake-pref-${this.sequence}`;
    const paymentId = `fake-payment-${this.sequence}`;
    const amountCents = order.items.reduce(
      (total, item) => total + item.quantity * item.unitPriceCents,
      0,
    );
    this.payments.set(paymentId, {
      paymentId,
      status: "pending",
      orderId: order.orderId,
      amountCents,
    });
    return {
      preferenceId,
      initPointUrl: `https://fake.mercadopago.local/checkout/${preferenceId}`,
    };
  }

  async getPayment(paymentId: string): Promise<Payment> {
    const payment = this.payments.get(paymentId);
    if (!payment) {
      throw new Error(`FakePaymentGateway: unknown payment ${paymentId}`);
    }
    return { ...payment };
  }

  async refundPayment(paymentId: string): Promise<void> {
    const payment = this.requirePayment(paymentId);
    if (payment.status !== "approved") {
      throw new Error(
        `FakePaymentGateway: cannot refund payment in status ${payment.status}`,
      );
    }
    payment.status = "refunded";
  }

  // --- Helpers de teste (não fazem parte da interface PaymentGateway) ---

  paymentIdForPreference(preferenceId: string): string {
    const paymentId = preferenceId.replace(/^fake-pref-/, "fake-payment-");
    this.requirePayment(paymentId);
    return paymentId;
  }

  approvePayment(paymentId: string, options?: { installments?: number }): void {
    const payment = this.requirePayment(paymentId);
    if (payment.status !== "pending") {
      throw new Error(
        `FakePaymentGateway: cannot approve payment in status ${payment.status}`,
      );
    }
    payment.status = "approved";
    payment.feeCents = Math.round(payment.amountCents * 0.05);
    payment.installments = options?.installments ?? 1;
  }

  rejectPayment(paymentId: string): void {
    const payment = this.requirePayment(paymentId);
    if (payment.status !== "pending") {
      throw new Error(
        `FakePaymentGateway: cannot reject payment in status ${payment.status}`,
      );
    }
    payment.status = "rejected";
  }

  cancelPayment(paymentId: string): void {
    const payment = this.requirePayment(paymentId);
    if (payment.status !== "pending") {
      throw new Error(
        `FakePaymentGateway: cannot cancel payment in status ${payment.status}`,
      );
    }
    payment.status = "cancelled";
  }

  reset(): void {
    this.payments.clear();
    this.sequence = 0;
  }

  private requirePayment(paymentId: string): Payment {
    const payment = this.payments.get(paymentId);
    if (!payment) {
      throw new Error(`FakePaymentGateway: unknown payment ${paymentId}`);
    }
    return payment;
  }
}
