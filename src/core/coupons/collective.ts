// Cupom da turma — PURO. Um código que circula no grupo de WhatsApp: cada
// cliente DISTINTA que usa sobe o desconto para as próximas, até um teto.
// A N-ésima cliente paga com value + growth × (N − 1) — quem compartilha
// melhora o cupom de todo mundo.
import { formatCentsBRL } from "@/lib/money";

export interface CollectiveCoupon {
  type: "percent" | "fixed" | "free_shipping";
  value: number;
  /** Pontos percentuais (percent) ou centavos (fixed) que cada nova cliente acrescenta; 0 = cupom comum. */
  growthPerRedeemer: number;
  /** Teto do desconto; obrigatório quando cresce. */
  growthCap: number | null;
}

export function isCollective(coupon: Pick<CollectiveCoupon, "growthPerRedeemer">): boolean {
  return coupon.growthPerRedeemer > 0;
}

/** O valor para a próxima cliente, dadas as clientes distintas que JÁ resgataram. */
export function collectiveValue(coupon: CollectiveCoupon, distinctRedeemers: number): number {
  if (!isCollective(coupon)) return coupon.value;
  const grown = coupon.value + coupon.growthPerRedeemer * Math.max(0, distinctRedeemers);
  return coupon.growthCap === null ? grown : Math.min(coupon.growthCap, grown);
}

function label(type: CollectiveCoupon["type"], value: number): string {
  return type === "percent" ? `${value}%` : formatCentsBRL(value);
}

function growthLabel(coupon: CollectiveCoupon): string {
  return coupon.type === "percent"
    ? `${coupon.growthPerRedeemer} ${coupon.growthPerRedeemer === 1 ? "ponto" : "pontos"}`
    : formatCentsBRL(coupon.growthPerRedeemer);
}

function friendsLabel(count: number): string {
  return count === 1 ? "1 amiga já usou" : `${count} amigas já usaram`;
}

/** Painel: "5% + 2 pontos por amiga (teto 15%) · 2 amigas · vale 9% agora". */
export function collectiveAdminLabel(coupon: CollectiveCoupon, distinctRedeemers: number): string | null {
  if (!isCollective(coupon)) return null;
  const cap = coupon.growthCap === null ? "" : ` (teto ${label(coupon.type, coupon.growthCap)})`;
  const friends = distinctRedeemers === 1 ? "1 amiga" : `${distinctRedeemers} amigas`;
  return `${label(coupon.type, coupon.value)} + ${growthLabel(coupon)} por amiga${cap} · ${friends} · vale ${label(coupon.type, collectiveValue(coupon, distinctRedeemers))} agora`;
}

/**
 * Loja e Lia: "Cupom da turma: 9% hoje — 2 amigas já usaram. Cada nova amiga
 * sobe 2 pontos, até 15%." / no teto: "Cupom da turma: 15% hoje — a turma
 * chegou ao teto (7 amigas)." / ninguém ainda: "…você pode ser a primeira…".
 */
export function collectiveCustomerHint(coupon: CollectiveCoupon, distinctRedeemers: number): string | null {
  if (!isCollective(coupon)) return null;
  const today = label(coupon.type, collectiveValue(coupon, distinctRedeemers));
  const atCap = coupon.growthCap !== null && collectiveValue(coupon, distinctRedeemers) >= coupon.growthCap;
  if (atCap) {
    return `Cupom da turma: ${today} hoje — a turma chegou ao teto (${distinctRedeemers === 1 ? "1 amiga" : `${distinctRedeemers} amigas`}).`;
  }
  const who = distinctRedeemers === 0 ? "você pode ser a primeira" : friendsLabel(distinctRedeemers);
  const cap = coupon.growthCap === null ? "" : `, até ${label(coupon.type, coupon.growthCap)}`;
  return `Cupom da turma: ${today} hoje — ${who}. Cada nova amiga sobe ${growthLabel(coupon)}${cap}.`;
}

/** O texto que a cliente manda para a amiga (WhatsApp), com o link que aplica o cupom. */
export function collectiveShareText(input: { code: string; currentValueLabel: string; storeName: string; siteUrl: string }): string {
  return `Tô usando o cupom ${input.code} na ${input.storeName}: quanto mais amigas usam, maior o desconto pra todo mundo. Hoje tá em ${input.currentValueLabel}. Pega o seu: ${input.siteUrl}/c/${input.code}`;
}
