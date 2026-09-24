// Origem do pedido feito no site: a última entrada rastreável que a cliente
// tocou neste navegador (link de story /ig/, link de cupom /c/). O pedido da
// Lia já é atribuído pela ponte (site_carts); sem isto, a venda que nasce no
// checkout do site ficava invisível para "De onde vieram".
import { z } from "zod";

export const ORIGIN_KINDS = ["campaign", "coupon"] as const;
export type OriginKind = (typeof ORIGIN_KINDS)[number];

/** A mesma régua da ponte da Lia (BRIDGE_ATTRIBUTION_MS): 7 dias. */
export const ORIGIN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Relógio do celular adiantado não pode fazer a origem nascer no futuro. */
const CLOCK_SKEW_MS = 10 * 60 * 1000;

const CAMPAIGN_SLUG = /^[a-z0-9-]{2,40}$/;
const COUPON_CODE = /^[A-Z0-9][A-Z0-9_-]{1,39}$/;

/** O que o navegador manda: validado no servidor (nunca confiado). */
export const storedOriginSchema = z.object({
  kind: z.enum(ORIGIN_KINDS),
  ref: z.string().trim().min(2).max(40),
  at: z.iso.datetime(),
});
export type StoredOrigin = z.infer<typeof storedOriginSchema>;

export interface OrderAttribution {
  kind: OriginKind;
  /** Slug do link de story ou código do cupom, já normalizado. */
  ref: string;
  touchedAt: string;
}

function normalizeRef(kind: OriginKind, ref: string): string | null {
  const trimmed = ref.trim();
  if (kind === "campaign") {
    const slug = trimmed.toLowerCase();
    return CAMPAIGN_SLUG.test(slug) ? slug : null;
  }
  const code = trimmed.toUpperCase();
  return COUPON_CODE.test(code) ? code : null;
}

/** A origem que vale para um pedido criado agora; null = sem origem ou vencida. */
export function attributionFrom(origin: StoredOrigin | null | undefined, now: Date): OrderAttribution | null {
  if (!origin) return null;
  const touched = Date.parse(origin.at);
  if (!Number.isFinite(touched)) return null;
  const age = now.getTime() - touched;
  if (age > ORIGIN_MAX_AGE_MS || age < -CLOCK_SKEW_MS) return null;
  const ref = normalizeRef(origin.kind, origin.ref);
  if (!ref) return null;
  return { kind: origin.kind, ref, touchedAt: new Date(Math.min(touched, now.getTime())).toISOString() };
}

/** Rótulo para o painel: "/ig/dunas" ou "cupom AMIGA7K". */
export function attributionLabel(attribution: Pick<OrderAttribution, "kind" | "ref">): string {
  return attribution.kind === "campaign" ? `/ig/${attribution.ref}` : `cupom ${attribution.ref}`;
}
