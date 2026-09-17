// A ponte do site para a Lia: "Falar com a Lia" grava o que a cliente estava
// vendo (peça e variação, ou a sacola inteira) com um código curto, e monta
// o link do WhatsApp com a mensagem pronta. A Lia consome a ponte quando a
// primeira mensagem chega (wa-inbound) e liga ao pedido ao fechar.

import { and, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";

import { DEFAULT_SELLER_NAME } from "@/core/bot/prompt";
import {
  BRIDGE_MAX_LINES,
  BRIDGE_MAX_QTY,
  BRIDGE_SOURCES,
  bridgeItemSchema,
  buildBridgeMessage,
  generateBridgeCode,
  originLabel,
  type BridgeItem,
  type BridgeSource,
  type BridgeState,
} from "@/core/bot/site-bridge";
import { variantLabel } from "@/core/catalog/attributes";
import { campaignLinks, orders, products, siteCarts } from "@/db/schema";
import { waMeUrl } from "@/lib/phone";
import type { DbOrTx } from "@/queue/enqueue";
import { getSettingsMap } from "@/services/settings";
import { getPublicProductBySlug, getSellableVariantById, getSellableVariantBySku } from "@/services/store-catalog";

export class ServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
  }
}

/** Colisão de código entre pontes abertas é rara (30^4); três tentativas bastam. */
const CODE_ATTEMPTS = 3;


const createSiteCartSchema = z.object({
  source: z.enum(BRIDGE_SOURCES),
  campaignSlug: z.string().trim().min(1).max(60).optional(),
  productSlug: z.string().trim().min(1).max(200).optional(),
  /** Só no story: a dona amarrou a peça ao link, então ela entra mesmo antes de ficar visível (janela VIP). */
  includeHiddenProduct: z.boolean().optional(),
  variantSku: z.string().trim().min(1).max(60).optional(),
  /** CEP do checkout sem frete (só na mensagem, para a Lia cotar; não fica gravado). */
  cep: z.string().regex(/^\d{8}$/).optional(),
  /**
   * A sacola (source = cart): variação (id, como a sacola guarda; SKU só como
   * reserva) e quantidade; o preço é lido na hora. Tetos acima do que a
   * sacola permite, para nenhuma sacola real cair no link sem código.
   */
  items: z
    .array(
      z
        .object({
          variantId: z.uuid().optional(),
          sku: z.string().trim().min(1).max(60).optional(),
          quantity: z.number().int().min(1).max(BRIDGE_MAX_QTY),
        })
        .refine((line) => line.variantId || line.sku, "Linha da sacola sem variação."),
    )
    .max(BRIDGE_MAX_LINES)
    .optional(),
});
export type CreateSiteCartInput = z.input<typeof createSiteCartSchema>;

export type SiteCartLink = {
  id: string;
  code: string;
  message: string;
  /** null quando a loja não tem WhatsApp configurado (o botão nem aparece). */
  waUrl: string | null;
};

/** Os settings que a ponte lê: o telefone da loja e o nome da vendedora. */
export async function loadBridgeSettings(db: DbOrTx): Promise<{ storeWhatsapp: string; sellerName: string }> {
  const map = await getSettingsMap(db, ["store_whatsapp", "bot_seller_name"]);
  const text = (key: string) => (typeof map[key] === "string" ? (map[key] as string).trim() : "");
  return { storeWhatsapp: text("store_whatsapp"), sellerName: text("bot_seller_name") || DEFAULT_SELLER_NAME };
}

/** O link "de emergência" sem código: quando a action falha, a cliente ainda chega à Lia. */
export function plainBridgeUrl(settings: { storeWhatsapp: string; sellerName: string }): string | null {
  return waMeUrl(settings.storeWhatsapp, `Oi ${settings.sellerName}, vim pelo site`);
}

async function snapshotItems(db: DbOrTx, input: z.output<typeof createSiteCartSchema>): Promise<{ items: BridgeItem[]; productId: string | null; product: { name: string; variation?: string } | null }> {
  if (input.source === "cart" && input.items && input.items.length > 0) {
    const items: BridgeItem[] = [];
    for (const line of input.items) {
      const variant =
        (line.variantId ? await getSellableVariantById(db, line.variantId) : null) ??
        (line.sku ? await getSellableVariantBySku(db, line.sku) : null);
      if (!variant) continue; // Peça que saiu do ar entre a sacola e o toque: fica de fora, sem derrubar.
      items.push({
        sku: variant.sku,
        name: variant.name,
        variation: variantLabel(variant.attributes, variant.attributesSchema),
        quantity: line.quantity,
        priceCents: variant.priceCents,
      });
    }
    return { items, productId: null, product: null };
  }
  if (input.variantSku) {
    const variant = await getSellableVariantBySku(db, input.variantSku);
    if (variant) {
      const variation = variantLabel(variant.attributes, variant.attributesSchema);
      return {
        items: [{ sku: variant.sku, name: variant.name, variation, quantity: 1, priceCents: variant.priceCents }],
        productId: variant.productId,
        product: { name: variant.name, variation },
      };
    }
  }
  if (input.productSlug) {
    const product = await getPublicProductBySlug(db, input.productSlug, undefined, {
      includeHidden: input.source === "campaign" && input.includeHiddenProduct === true,
    });
    if (product) {
      // Sem variação escolhida: a peça, com o primeiro preço como referência.
      const first = product.variants[0];
      return {
        items: first ? [{ sku: first.sku, name: product.name, variation: "", quantity: 1, priceCents: first.priceCents }] : [],
        productId: product.id,
        product: { name: product.name },
      };
    }
  }
  return { items: [], productId: null, product: null };
}

/**
 * Grava a ponte e devolve o link do WhatsApp com a mensagem pronta. A peça
 * ou a sacola são fotografadas na hora (nome, variação, preço), para o funil
 * e o caderninho não dependerem do que mudar depois.
 */
export async function createSiteCart(db: DbOrTx, rawInput: CreateSiteCartInput): Promise<SiteCartLink> {
  const input = createSiteCartSchema.parse(rawInput);
  const [settings, snapshot] = await Promise.all([loadBridgeSettings(db), snapshotItems(db, input)]);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
    const code = generateBridgeCode();
    try {
      const [row] = await db
        .insert(siteCarts)
        .values({
          code,
          source: input.source,
          campaignSlug: input.source === "campaign" ? (input.campaignSlug ?? null) : null,
          productId: snapshot.productId,
          variantSku: input.variantSku ?? null,
          items: snapshot.items,
        })
        .returning({ id: siteCarts.id });
      const message = buildBridgeMessage({
        sellerName: settings.sellerName,
        code,
        source: input.source,
        product: snapshot.product,
        items: snapshot.items,
        cep: input.cep,
      });
      return { id: row.id, code, message, waUrl: waMeUrl(settings.storeWhatsapp, message) };
    } catch (error) {
      // Código igual a uma ponte ainda aberta: tenta outro.
      if (isUniqueViolation(error)) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }
  throw new ServiceError("codigo_indisponivel", `Não consegui gerar um código para a ponte: ${String(lastError)}`);
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } })?.code ?? (error as { cause?: { code?: string } })?.cause?.code;
  return code === "23505";
}

/** A ponte pelo id (painel e testes). */
export async function getSiteCart(db: DbOrTx, id: string) {
  const [row] = await db.select().from(siteCarts).where(eq(siteCarts.id, z.uuid().parse(id))).limit(1);
  return row ?? null;
}

/** Uma ponte vale por uma semana: código mais velho que isso não é reconhecido. */
export const BRIDGE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A primeira mensagem trouxe o código: consome a ponte (uma vez só — a
 * UNIQUE parcial garante que só há uma aberta com esse código), liga à
 * conversa e devolve o que o caderninho guarda. null quando não há ponte
 * aberta com esse código (código inventado, velho ou já usado).
 */
export async function consumeSiteCartByCode(
  db: DbOrTx,
  input: { code: string; conversationId: string; now: Date },
): Promise<BridgeState | null> {
  const code = input.code.trim().toUpperCase();
  const since = new Date(input.now.getTime() - BRIDGE_MAX_AGE_MS);
  const [row] = await db
    .update(siteCarts)
    .set({ consumedAt: input.now, conversationId: input.conversationId })
    .where(and(eq(siteCarts.code, code), isNull(siteCarts.consumedAt), gte(siteCarts.createdAt, since)))
    .returning();
  if (!row) return null;
  const items = z.array(bridgeItemSchema).safeParse(row.items);
  const list = items.success ? items.data : [];
  const [product] = row.productId
    ? await db.select({ slug: products.slug, name: products.name }).from(products).where(eq(products.id, row.productId)).limit(1)
    : [];
  // No story, a origem é o rótulo do link ("Dunas no story"); apagado, fica o slug.
  const [campaign] = row.campaignSlug
    ? await db.select({ label: campaignLinks.label }).from(campaignLinks).where(eq(campaignLinks.slug, row.campaignSlug)).limit(1)
    : [];
  const source = row.source as BridgeSource;
  const first = list[0];
  return {
    siteCartId: row.id,
    code,
    source,
    sourceLabel: originLabel(source, campaign?.label ?? row.campaignSlug),
    // "Veio do site agora" conta da chegada da mensagem: quem tocou ontem e
    // escreveu hoje também merece a linha de estoque no primeiro turno.
    at: input.now.toISOString(),
    ...(product ? { productSlug: product.slug, productName: product.name } : first && source !== "cart" ? { productName: first.name } : {}),
    ...(source !== "cart" && first?.variation ? { variation: first.variation } : {}),
    ...(list.length > 0 ? { items: list } : {}),
  };
}

/** Uma ponte só "converte" em pedido fechado até uma semana depois de chegar. */
export const BRIDGE_ATTRIBUTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * O pedido fechou nesta conversa: a ponte consumida mais recente (ainda sem
 * pedido, chegada há menos de uma semana) ganha o order_id — é o que o funil
 * conta como venda pela ponte. Ponte velha não herda pedido de outra visita.
 */
export async function markSiteCartOrdered(
  db: DbOrTx,
  input: { conversationId: string; orderId: string; now?: Date },
): Promise<boolean> {
  const since = new Date((input.now ?? new Date()).getTime() - BRIDGE_ATTRIBUTION_MS);
  const [latest] = await db
    .select({ id: siteCarts.id })
    .from(siteCarts)
    .where(and(eq(siteCarts.conversationId, input.conversationId), isNull(siteCarts.orderId), gte(siteCarts.consumedAt, since)))
    .orderBy(desc(siteCarts.consumedAt), desc(siteCarts.createdAt))
    .limit(1);
  if (!latest) return false;
  await db.update(siteCarts).set({ orderId: input.orderId }).where(eq(siteCarts.id, latest.id));
  return true;
}

/** "Estoque agora: Longo Dunas (Areia · M): 2 disponíveis" — para o primeiro turno depois da ponte. */
export async function bridgeStockLine(db: DbOrTx, bridge: BridgeState): Promise<string | null> {
  const items = (bridge.items ?? []).slice(0, 5);
  if (items.length === 0) return null;
  const parts: string[] = [];
  for (const item of items) {
    // A ponte nasceu de uma sacola válida: a convidada da janela VIP já viu a
    // peça escondida — a Lia precisa do estoque dela, não de "saiu do catálogo".
    const variant = await getSellableVariantBySku(db, item.sku, { includeHidden: true });
    const label = `${item.name}${item.variation ? ` (${item.variation})` : ""}`;
    if (!variant) {
      parts.push(`${label}: saiu do catálogo`);
      continue;
    }
    const qty = variant.availableQty;
    parts.push(`${label}: ${qty === 0 ? "esgotada" : qty === 1 ? "1 disponível" : `${qty} disponíveis`}, SKU ${variant.sku}`);
  }
  return `Estoque agora das peças da ponte: ${parts.join("; ")}`;
}

export type BridgeFunnelRow = {
  source: BridgeSource;
  campaignSlug: string | null;
  /** "página da peça", "sacola", "rodapé do site", "story «Dunas no story»". */
  label: string;
  /** Toques = pontes criadas; conversas = consumidas; pedidos = com pedido; pagos = pedido pago (e a soma). */
  taps: number;
  conversations: number;
  orders: number;
  paidOrders: number;
  paidCents: number;
};

export type BridgeFunnel = {
  rows: BridgeFunnelRow[];
  totals: Omit<BridgeFunnelRow, "source" | "campaignSlug" | "label">;
};

/** Pedido "pago" como nos relatórios: paid_at preenchido E não cancelado/reembolsado (paid_at nunca é apagado). */
const paidOrder = () => sql`${orders.paidAt} is not null and ${orders.status} not in ('canceled', 'refunded')`;

const funnelAggregates = {
  taps: sql<number>`count(*)::int`,
  // Toques = pontes; conversas = conversas DISTINTAS (a mesma cliente pode
  // mandar dois códigos no mesmo chat) — a mesma régua da Central de links.
  conversations: sql<number>`count(distinct ${siteCarts.conversationId})::int`,
  orders: sql<number>`count(distinct ${siteCarts.orderId})::int`,
  paidOrders: sql<number>`count(distinct case when ${paidOrder()} then ${orders.id} end)::int`,
  // Dinheiro por PEDIDO distinto (um pedido em duas pontes soma uma vez):
  // soma dos totais dos ids únicos do grupo.
  paidCents: sql<number>`coalesce((
    select sum(t.total_cents) from (
      select distinct unnest(array_agg(case when ${paidOrder()} then ${orders.id} end)) as id,
             unnest(array_agg(case when ${paidOrder()} then ${orders.totalCents} end)) as total_cents
    ) t where t.id is not null
  ), 0)::int`,
};

/**
 * "De onde vieram": por origem (e por link de story), no período [from, to):
 * quantas tocaram (pontes), quantas conversas chegaram, quantos pedidos e
 * quantos pagos (regra dos relatórios: cancelado/reembolsado não é venda).
 * Os totais são calculados sobre o período inteiro (uma conversa com pontes
 * de duas origens conta uma vez no total). Ordenado por toques.
 */
export async function siteBridgeFunnel(db: DbOrTx, input: { from: Date; to: Date }): Promise<BridgeFunnel> {
  const period = and(gte(siteCarts.createdAt, input.from), lt(siteCarts.createdAt, input.to));
  const [rows, [overall]] = await Promise.all([
    db
      .select({
        source: siteCarts.source,
        campaignSlug: siteCarts.campaignSlug,
        campaignLabel: campaignLinks.label,
        ...funnelAggregates,
      })
      .from(siteCarts)
      .leftJoin(campaignLinks, and(eq(siteCarts.source, "campaign"), eq(campaignLinks.slug, siteCarts.campaignSlug)))
      .leftJoin(orders, eq(orders.id, siteCarts.orderId))
      .where(period)
      .groupBy(siteCarts.source, siteCarts.campaignSlug, campaignLinks.label),
    db
      .select(funnelAggregates)
      .from(siteCarts)
      .leftJoin(orders, eq(orders.id, siteCarts.orderId))
      .where(period),
  ]);
  const list: BridgeFunnelRow[] = rows
    .map((row) => {
      const source = row.source as BridgeSource;
      return {
        source,
        campaignSlug: source === "campaign" ? row.campaignSlug : null,
        label: originLabel(source, row.campaignLabel ?? row.campaignSlug),
        taps: Number(row.taps),
        conversations: Number(row.conversations),
        orders: Number(row.orders),
        paidOrders: Number(row.paidOrders),
        paidCents: Number(row.paidCents),
      };
    })
    .sort((a, b) => b.taps - a.taps || a.label.localeCompare(b.label, "pt-BR"));
  const totals = {
    taps: Number(overall?.taps ?? 0),
    conversations: Number(overall?.conversations ?? 0),
    orders: Number(overall?.orders ?? 0),
    paidOrders: Number(overall?.paidOrders ?? 0),
    paidCents: Number(overall?.paidCents ?? 0),
  };
  return { rows: list, totals };
}

/** Quantas pontes há por conversa (o funil e o painel). */
export async function countSiteCartsByConversation(db: DbOrTx, conversationId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(siteCarts)
    .where(eq(siteCarts.conversationId, conversationId));
  return Number(row?.n ?? 0);
}

export type { BridgeSource };
export { BRIDGE_MAX_LINES, BRIDGE_MAX_QTY };
