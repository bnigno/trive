// O cupom de bolso da Lia — PURO. A dona dá à vendedora uma cota pequena de
// "gentilezas" por dia: um cupom pessoal, de poucos dias, sobre a sacola
// atual, para a cliente que hesitou no preço, é de casa ou está de
// aniversário. QUEM DECIDE é esta função, com os fatos que o serviço
// carrega — a Lia só pede; se a resposta é não, ela não menciona desconto.
import { z } from "zod";

import { formatCentsBRL } from "@/lib/money";
import { spDayEnd, spDayKey } from "@/lib/sp-day";

import { couponCodePrefix } from "./codes";

export const liaGiftPolicySchema = z.object({
  enabled: z.boolean(),
  percent: z.number().int().min(1).max(50),
  dailyQuota: z.number().int().min(0).max(20),
  minPurchases: z.number().int().min(0).max(10),
  minCartCents: z.number().int().min(0),
  validDays: z.number().int().min(1).max(30),
  cooldownDays: z.number().int().min(0).max(365),
});
export type LiaGiftPolicy = z.infer<typeof liaGiftPolicySchema>;

export const LIA_GIFT_DEFAULTS: LiaGiftPolicy = {
  enabled: false,
  percent: 10,
  dailyQuota: 3,
  minPurchases: 1,
  minCartCents: 15_000,
  validDays: 2,
  cooldownDays: 60,
};

export interface LiaGiftFacts {
  now: Date;
  customerId: string | null;
  priorPurchases: number;
  cartSubtotalCents: number;
  /** Gentilezas emitidas hoje (dia de São Paulo), em todas as conversas. */
  issuedTodayCount: number;
  /** Última gentileza desta cliente; null = nunca. */
  lastGiftAt: Date | null;
  alreadyOfferedInConversation: boolean;
  /** Já há cupom validado no caderninho. */
  hasValidatedCoupon: boolean;
  copilot: boolean;
  proactive: boolean;
}

export type LiaGiftRefusal =
  | "disabled"
  | "proactive"
  | "copilot"
  | "unidentified"
  | "already_offered"
  | "has_coupon"
  | "empty_cart"
  | "cart_too_small"
  | "few_purchases"
  | "cooldown"
  | "quota"
  /** O cupom nasceu mas não vale para a sacola de agora (o serviço desfez). */
  | "unquotable";

export type LiaGiftDecision =
  | { ok: true; percent: number; expiresAt: Date }
  | { ok: false; code: LiaGiftRefusal; reason: string };

const REFUSAL_REASONS: Record<LiaGiftRefusal, string> = {
  disabled: "recurso desligado",
  proactive: "turno de retomada",
  copilot: "copiloto",
  unidentified: "cliente sem cadastro",
  already_offered: "já ofereceu nesta conversa",
  has_coupon: "já há cupom validado",
  empty_cart: "sacola vazia",
  cart_too_small: "sacola abaixo do mínimo",
  few_purchases: "cliente ainda não comprou o bastante",
  cooldown: "ganhou uma gentileza há pouco tempo",
  quota: "cota do dia esgotada",
  unquotable: "cupom não vale para esta sacola",
};

function refuse(code: LiaGiftRefusal): LiaGiftDecision {
  return { ok: false, code, reason: REFUSAL_REASONS[code] };
}

/** Fim do dia de São Paulo de `now + validDays` (a Lia diz "vale até dd/mm"). */
export function liaGiftExpiresAt(now: Date, validDays: number): Date {
  const lastDay = spDayKey(new Date(now.getTime() + validDays * 86_400_000));
  return new Date(spDayEnd(lastDay).getTime() - 1000);
}

/** A primeira condição que falha decide. */
export function decideLiaGift(policy: LiaGiftPolicy, facts: LiaGiftFacts): LiaGiftDecision {
  if (!policy.enabled) return refuse("disabled");
  if (facts.proactive) return refuse("proactive");
  if (facts.copilot) return refuse("copilot");
  if (facts.customerId === null) return refuse("unidentified");
  if (facts.alreadyOfferedInConversation) return refuse("already_offered");
  if (facts.hasValidatedCoupon) return refuse("has_coupon");
  if (facts.cartSubtotalCents <= 0) return refuse("empty_cart");
  if (facts.cartSubtotalCents < policy.minCartCents) return refuse("cart_too_small");
  if (facts.priorPurchases < policy.minPurchases) return refuse("few_purchases");
  if (
    policy.cooldownDays > 0 &&
    facts.lastGiftAt !== null &&
    facts.now.getTime() - facts.lastGiftAt.getTime() < policy.cooldownDays * 86_400_000
  ) {
    return refuse("cooldown");
  }
  if (facts.issuedTodayCount >= policy.dailyQuota) return refuse("quota");
  return { ok: true, percent: policy.percent, expiresAt: liaGiftExpiresAt(facts.now, policy.validDays) };
}

/** "MARIA-CARINHO"; sem nome: "CARINHO-K7X2" (sufixo dado por quem chama). */
export function liaGiftCode(fullName: string | null, fallbackSuffix: string): string {
  const prefix = couponCodePrefix(fullName, "");
  return prefix === "" ? `CARINHO-${fallbackSuffix.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4) || "LIA"}` : `${prefix}-CARINHO`;
}

export function liaGiftDedupeKey(conversationId: string, dayKey: string): string {
  return `lia_gift:${conversationId}:${dayKey}`;
}

const dateFormatter = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" });

/** O que a Lia recebe quando a gentileza sai. */
export function liaGiftToolText(input: { code: string; percent: number; discountCents: number; subtotalCents: number; expiresAt: Date; motivo: string }): string {
  return [
    `Gentileza registrada: cupom ${input.code} — ${input.percent}% na sacola atual (desconto de ${formatCentsBRL(input.discountCents)} sobre ${formatCentsBRL(input.subtotalCents)} → ${formatCentsBRL(input.subtotalCents - input.discountCents)}, frete à parte), vale até ${dateFormatter.format(input.expiresAt)}.`,
    `Ofereça em 1 frase, ligada ao motivo ("${input.motivo}"), como um gesto da loja para ela — não como "cupom de desconto" genérico. Passe cupom: "${input.code}" em criar_pedido — o desconto entra ao fechar. Uma vez por conversa.`,
  ].join("\n");
}

/** O que a Lia recebe quando a resposta é não: silêncio sobre desconto. */
export function liaGiftRefusalText(decision: { code: LiaGiftRefusal; reason: string }): string {
  return `Sem gentileza agora (${decision.reason}). NÃO mencione desconto, cupom nem que tentou — siga a conversa normalmente.`;
}
