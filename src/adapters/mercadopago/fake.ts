import type {
  CheckoutPreference,
  CreateCheckoutPreferenceInput,
  Payment,
  PaymentGateway,
  RefundOptions,
  RefundResult,
} from "./index";

export class FakePaymentGateway implements PaymentGateway {
  private readonly payments = new Map<string, Payment>();
  private sequence = 0;

  async createCheckoutPreference(
    input: CreateCheckoutPreferenceInput,
  ): Promise<CheckoutPreference> {
    this.sequence += 1;
    const preferenceId = `fake-pref-${this.sequence}`;
    const paymentId = `fake-payment-${this.sequence}`;
    const amountCents = input.items.reduce(
      (total, item) => total + item.quantity * item.unitPriceCents,
      0,
    );
    this.payments.set(paymentId, {
      paymentId,
      status: "pending",
      externalReference: input.externalReference,
      amountCents,
      feeCents: null,
      installments: null,
      paymentMethod: "pix",
    });
    return {
      preferenceId,
      initPointUrl: `https://fake.mercadopago.local/checkout/${preferenceId}`,
    };
  }

  async getPayment(paymentId: string): Promise<Payment> {
    return { ...this.requirePayment(paymentId) };
  }

  async refundPayment(paymentId: string, options: RefundOptions = {}): Promise<RefundResult> {
    const payment = this.requirePayment(paymentId);
    const parcial = options.amountCents !== undefined;
    // Parcial não encerra o pagamento: dá para devolver outra peça depois.
    if (payment.status !== "approved") {
      throw new Error(
        `FakePaymentGateway: cannot refund payment in status ${payment.status}`,
      );
    }
    // A chave repetida é o que o MP descarta em silêncio — aqui isso aparece.
    const key = options.idempotencyKey ?? `refund:${paymentId}`;
    if (this.refundKeys.has(key)) {
      return { refundId: `fake-refund-${key}`, status: "approved" };
    }
    this.refundKeys.add(key);
    if (!parcial) payment.status = "refunded";
    this.refundCalls.push({ paymentId, amountCents: options.amountCents ?? null });
    return { refundId: `fake-refund-${key}`, status: "approved" };
  }

  /** Teste: cada chamada real ao vendor (estorno duplicado é dinheiro a mais). */
  readonly refundCalls: { paymentId: string; amountCents: number | null }[] = [];
  private readonly refundKeys = new Set<string>();

  // --- Helpers de teste (não fazem parte da interface PaymentGateway) ---

  paymentIdForPreference(preferenceId: string): string {
    const paymentId = preferenceId.replace(/^fake-pref-/, "fake-payment-");
    this.requirePayment(paymentId);
    return paymentId;
  }

  approvePayment(
    paymentId: string,
    options?: { installments?: number; paymentMethod?: Payment["paymentMethod"] },
  ): void {
    const payment = this.requirePayment(paymentId);
    if (payment.status !== "pending") {
      throw new Error(
        `FakePaymentGateway: cannot approve payment in status ${payment.status}`,
      );
    }
    payment.status = "approved";
    // Taxa fake de 5% arredondada, espelhando a taxa REAL que o adapter de
    // produção extrai de fee_details.
    payment.feeCents = Math.round(payment.amountCents * 0.05);
    payment.installments = options?.installments ?? 1;
    if (options?.paymentMethod) payment.paymentMethod = options.paymentMethod;
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
