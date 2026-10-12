// Crédito da cliente: dinheiro que a TRIVÉ deve a ela (peça devolvida →
// "troca"; preço que caiu depois da compra → "price_protection"). É de uso
// único e o que passa da compra se perde — por isso só entra num pedido com
// o SIM dela (caso real do #1030: a Lia aplicou sozinha um crédito de
// R$ 49,50 que a cliente queria guardar). PURO.
import { formatCentsBRL } from "@/lib/money";

export const STORE_CREDIT_ORIGINS = ["troca", "price_protection"] as const;

export function isStoreCredit(origin: string | null | undefined): boolean {
  return origin !== null && origin !== undefined && (STORE_CREDIT_ORIGINS as readonly string[]).includes(origin);
}

/** Quanto do crédito sobraria (e se perderia) com este desconto. */
export function creditLeftoverCents(valueCents: number, discountCents: number): number {
  return Math.max(0, valueCents - discountCents);
}

export type StoreCredit = { code: string; valueCents: number; expiresAt: Date | null };

function dayMonth(date: Date): string {
  return date.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" });
}

/**
 * A linha do caderninho: a Lia sabe do crédito ativo e pergunta antes de
 * usar. Vencido fica de fora; nenhum = null.
 */
export function storeCreditMemoryLine(credits: readonly StoreCredit[], now: Date): string | null {
  const active = credits.filter((credit) => credit.valueCents > 0 && (credit.expiresAt === null || credit.expiresAt.getTime() > now.getTime()));
  if (active.length === 0) return null;
  const list = active
    .map((credit) => `${credit.code} — ${formatCentsBRL(credit.valueCents)}${credit.expiresAt ? `, vale até ${dayMonth(credit.expiresAt)}` : ""}`)
    .join("; ");
  return `Crédito dela: ${list} (uso único; o que passar da compra se perde). Só entra no pedido com o SIM dela: ao fechar, pergunte se quer usar agora.`;
}

/** Como chamar o crédito para ela, pela origem (a Lia não diz "troca" para quem não devolveu nada). */
export function storeCreditLabel(origin: string | null | undefined): string {
  return origin === "price_protection" ? "crédito de proteção de preço (a peça baixou depois da compra)" : "crédito de troca (peça devolvida)";
}

export type CreditConsent = { ok: true } | { ok: false; reason: "omitted" | "not_asked" | "same_turn" };

/**
 * O crédito pode entrar neste pedido? Só com o código explícito E depois de
 * a cliente RESPONDER à pergunta — "respondeu" é fato do histórico (uma fala
 * da Lia depois da pergunta e, depois dela, uma mensagem nova dela), que o
 * service confere; o mesmo turno, um turno de iniciativa ou uma mensagem
 * que ela mandou antes de ver a pergunta não são o SIM.
 * - omitted: há crédito validado e o cupom veio omitido → perguntar.
 * - not_asked: o código explícito é crédito que não passou pela pergunta.
 * - same_turn: a pergunta ainda não foi respondida; espere a resposta dela.
 */
export function creditConsent(input: {
  /** criar_pedido.cupom como veio (undefined = omitido; "" = sem cupom). */
  explicitCode: string | undefined;
  /** O código explícito é crédito dela (origem conferida no banco). */
  explicitIsCredit: boolean;
  /** O crédito validado nesta conversa, com a mensagem dela quando a Lia perguntou. */
  validatedCredit: { code: string; askedInbound: string | null } | null;
  /** Ela respondeu à pergunta (conferido no histórico pelo service). */
  questionAnswered: boolean;
}): CreditConsent {
  const explicit = input.explicitCode?.trim().toUpperCase();
  if (explicit === undefined) return input.validatedCredit ? { ok: false, reason: "omitted" } : { ok: true };
  if (explicit === "" || !input.explicitIsCredit) return { ok: true };
  const asked = input.validatedCredit;
  if (!asked || asked.code.toUpperCase() !== explicit || asked.askedInbound === null) return { ok: false, reason: "not_asked" };
  if (!input.questionAnswered) return { ok: false, reason: "same_turn" };
  return { ok: true };
}
