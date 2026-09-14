// "Chegou bem?" — PURO. As cinco respostas da lista tocável, os ids das
// linhas (a Z-API devolve o id em listResponseMessage.selectedRowId), o
// texto que a resposta assume no histórico da Lia e quando perguntar.

export const FEEDBACK_ANSWERS = ["amei", "grande", "pequeno", "defeito", "falar"] as const;
export type FeedbackAnswer = (typeof FEEDBACK_ANSWERS)[number];

/** Um dia depois da entrega (dentro da janela de envio). */
export const FEEDBACK_DELAY_MS = 24 * 60 * 60 * 1000;

/** Títulos ≤ 24 caracteres (limite da lista da Z-API). */
export const FEEDBACK_TITLES: Record<FeedbackAnswer, string> = {
  amei: "Amei 🤎",
  grande: "Ficou grande",
  pequeno: "Ficou pequeno",
  defeito: "Veio com defeito",
  falar: "Quero falar com alguém",
};

export const FEEDBACK_DESCRIPTIONS: Partial<Record<FeedbackAnswer, string>> = {
  grande: "A gente ajuda com a troca",
  pequeno: "A gente ajuda com a troca",
  defeito: "Resolvemos já",
  falar: "A equipe te chama",
};

/** O que a resposta significa para a maison (painel e caderninho). */
export const FEEDBACK_LABELS: Record<FeedbackAnswer, string> = {
  amei: "Amei",
  grande: "Ficou grande",
  pequeno: "Ficou pequeno",
  defeito: "Veio com defeito",
  falar: "Quer falar com alguém",
};

/** Quem cuida: a Lia (ajusta a cartela e oferece a troca) ou a equipe direto. */
export function feedbackHandledBy(answer: FeedbackAnswer): "lia" | "human" {
  return answer === "defeito" || answer === "falar" ? "human" : "lia";
}

export function isFeedbackAnswer(value: unknown): value is FeedbackAnswer {
  return typeof value === "string" && (FEEDBACK_ANSWERS as readonly string[]).includes(value);
}

/** "feedback:grande:<orderId>" — 53 caracteres, dentro dos 64 da Z-API. */
export function feedbackRowId(answer: FeedbackAnswer, orderId: string): string {
  return `feedback:${answer}:${orderId}`;
}

export function parseFeedbackRowId(rowId: string | undefined): { answer: FeedbackAnswer; orderId: string } | null {
  if (!rowId || !rowId.startsWith("feedback:")) return null;
  const [, answer, orderId] = rowId.split(":");
  if (!isFeedbackAnswer(answer) || !orderId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId)) return null;
  return { answer, orderId };
}

export function feedbackOptions(orderId: string): { id: string; title: string; description?: string }[] {
  return FEEDBACK_ANSWERS.map((answer) => ({
    id: feedbackRowId(answer, orderId),
    title: FEEDBACK_TITLES[answer],
    ...(FEEDBACK_DESCRIPTIONS[answer] ? { description: FEEDBACK_DESCRIPTIONS[answer] } : {}),
  }));
}

/** O toque vira texto no histórico da Lia (e no painel), com o contexto do pedido. */
export function feedbackHistoryText(input: { answer: FeedbackAnswer; orderNumber: number; itemLabel: string | null; previous?: FeedbackAnswer | null }): string {
  const item = input.itemLabel ? ` (${input.itemLabel})` : "";
  const previous = input.previous ? ` (antes tinha respondido "${FEEDBACK_LABELS[input.previous]}")` : "";
  return `[resposta ao "Chegou bem?" do pedido #${input.orderNumber}${item}]: ${FEEDBACK_LABELS[input.answer]}${previous}`;
}

/** A linha do caderninho: "Pedido #1042 (Longo Dunas · M): respondeu 'Ficou grande' em 05/09". */
export function feedbackMemoryLine(input: { orderNumber: number; itemLabel: string | null; answer: FeedbackAnswer; dayLabel: string }): string {
  const item = input.itemLabel ? ` (${input.itemLabel})` : "";
  return `Pedido #${input.orderNumber}${item}: respondeu "${FEEDBACK_LABELS[input.answer]}" ao Chegou bem? em ${input.dayLabel}`;
}
