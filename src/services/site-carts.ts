// A ponte do site para a Lia: "Falar com a Lia" grava o que a cliente estava
// vendo (peça e variação, ou a sacola inteira) com um código curto, e monta
// o link do WhatsApp com a mensagem pronta. A Lia consome a ponte quando a
// primeira mensagem chega (wa-inbound) e liga ao pedido ao fechar.

import { eq } from "drizzle-orm";
import { z } from "zod";

import { DEFAULT_SELLER_NAME } from "@/core/bot/prompt";
import {
  BRIDGE_MAX_LINES,
  BRIDGE_MAX_QTY,
  BRIDGE_SOURCES,
  buildBridgeMessage,
  generateBridgeCode,
  type BridgeItem,
  type BridgeSource,
} from "@/core/bot/site-bridge";
import { variantLabel } from "@/core/catalog/attributes";
import { siteCarts } from "@/db/schema";
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
  variantSku: z.string().trim().min(1).max(60).optional(),
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
    const product = await getPublicProductBySlug(db, input.productSlug);
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

export type { BridgeSource };
export { BRIDGE_MAX_LINES, BRIDGE_MAX_QTY };
