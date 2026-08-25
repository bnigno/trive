// Formatação de exibição da área de clientes (puro, sem I/O).

/** '+5511999998888' → '(11) 99999-8888'; devolve o original se não reconhecer. */
export function formatPhoneBR(phoneE164: string | null): string {
  if (!phoneE164) return "—";
  const match = /^\+55(\d{2})(\d{8,9})$/.exec(phoneE164);
  if (!match) return phoneE164;
  const [, ddd, subscriber] = match;
  const split = subscriber.length - 4;
  return `(${ddd}) ${subscriber.slice(0, split)}-${subscriber.slice(split)}`;
}

/** Aplica máscara de CPF/CNPJ para exibição. */
export function formatDocumentBR(
  type: string | null,
  digits: string | null,
): string {
  if (!type || !digits) return "—";
  if (type === "cpf" && digits.length === 11) {
    return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
  }
  if (type === "cnpj" && digits.length === 14) {
    return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`;
  }
  return digits;
}

export const dateTimeFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export const ORDER_STATUS_LABELS: Record<string, string> = {
  draft: "Rascunho",
  pending_payment: "Aguardando pagamento",
  paid: "Pago",
  preparing: "Em preparação",
  shipped: "Enviado",
  delivered: "Entregue",
  canceled: "Cancelado",
  refunded: "Reembolsado",
};

export function orderStatusLabel(status: string): string {
  return ORDER_STATUS_LABELS[status] ?? status;
}
