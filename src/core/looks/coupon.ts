// O mimo pela foto — PURO. Quando a cliente manda a foto DELA usando uma
// peça que comprou (e chegou), a casa agradece com um cupom pessoal. Nasce
// no registro da foto (a Lia está no turno e fala com naturalidade), não no
// "sim" de publicar — o consentimento continua livre, o cupom agradece a
// foto. Anti-print: foto a menos de PHOTO_MATCH_MAX_DISTANCE de uma foto do
// catálogo é o próprio catálogo, não ela.
import { PHOTO_MATCH_MAX_DISTANCE } from "@/core/bot/photo-match";

export type LookCouponRefusal = "desligado" | "sem_cadastro" | "sem_compra_entregue" | "foto_de_catalogo";

export interface LookCouponEligibilityInput {
  enabled: boolean;
  customerId: string | null;
  /** O pedido ENTREGUE com a peça; null = não há. */
  deliveredOrderId: string | null;
  /** Distâncias (hamming) da foto às fotos do catálogo; null = sem hash (reconhecimento desligado). */
  catalogDistances: number[] | null;
}

export function lookCouponEligibility(input: LookCouponEligibilityInput): { ok: true } | { ok: false; reason: LookCouponRefusal } {
  if (!input.enabled) return { ok: false, reason: "desligado" };
  if (input.customerId === null) return { ok: false, reason: "sem_cadastro" };
  if (input.deliveredOrderId === null) return { ok: false, reason: "sem_compra_entregue" };
  if (input.catalogDistances !== null && input.catalogDistances.some((distance) => distance <= PHOTO_MATCH_MAX_DISTANCE)) {
    return { ok: false, reason: "foto_de_catalogo" };
  }
  return { ok: true };
}

/** Uma vez por peça, para sempre. */
export function lookCouponDedupeKey(customerId: string, productId: string): string {
  return `look_photo:${customerId}:${productId}`;
}

const dateFormatter = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" });

/** A linha que vai na legenda do cartão (determinística — a Lia pode errar o código, o cartão não). */
export function lookCouponCaptionLine(input: { code: string; percent: number; expiresAt: Date }): string {
  return `Seu mimo: cupom ${input.code} (${input.percent}% até ${dateFormatter.format(input.expiresAt)}) 🤎`;
}

/** O que a Lia lê depois de registrar a foto. */
export function lookCouponToolHint(input: { code: string; percent: number; expiresAt: Date; created: boolean }): string {
  if (!input.created) return `Ela já tinha ganhado o cupom ${input.code} por essa peça: não prometa outro.`;
  return `Ela ganhou o cupom ${input.code} (${input.percent}% até ${dateFormatter.format(input.expiresAt)}): diga isso em 1 frase, com o código EXATAMENTE assim; o cartão que chega em instantes repete o código.`;
}

/** O que a Lia lê quando não há mimo (ela não menciona cupom). */
export function lookCouponRefusalHint(reason: LookCouponRefusal): string | null {
  switch (reason) {
    case "desligado":
    case "sem_cadastro":
    case "sem_compra_entregue":
      return null;
    case "foto_de_catalogo":
      return "A foto parece ser do catálogo/print, não dela com a peça: sem cupom (não mencione).";
  }
}
