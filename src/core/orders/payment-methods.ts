// Fonte única das formas de pagamento (substitui as duplicações espalhadas
// em admin/relatórios/wa-messaging). MP_PAYMENT_METHODS = as processadas
// pelo Mercado Pago; pix_manual e cash são liquidadas manualmente pelo dono.

export const ALL_PAYMENT_METHODS = [
  "pix",
  "credit_card",
  "boleto",
  "pix_manual",
  "cash",
] as const;

export type PaymentMethod = (typeof ALL_PAYMENT_METHODS)[number];

export const MP_PAYMENT_METHODS = ["pix", "credit_card", "boleto"] as const;

export type MpPaymentMethod = (typeof MP_PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  pix: "Pix",
  credit_card: "Cartão de crédito",
  boleto: "Boleto",
  pix_manual: "Pix manual",
  cash: "Dinheiro na entrega",
};

export const PAYMENT_METHOD_LABELS_SHORT: Record<PaymentMethod, string> = {
  ...PAYMENT_METHOD_LABELS,
  credit_card: "Cartão",
};
