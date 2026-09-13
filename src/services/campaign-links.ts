// Links de story (/ig/[slug]): a dona cria "dunas" com a peça e um rótulo,
// cola trivemaison.com.br/ig/dunas no sticker do story; quem toca cai no
// WhatsApp da Lia com "Oi Lia, vi o Longo Dunas no story (#Q3MN)". Cada
// toque nasce em site_carts (source 'campaign'): o funil conta toques →
// conversas → pedidos por link.

import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";

import { normalizeCampaignSlug } from "@/core/bot/site-bridge";
import { auditLog, campaignLinks, products, siteCarts } from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { createSiteCart, loadBridgeSettings, plainBridgeUrl, type SiteCartLink } from "@/services/site-carts";
import { getPublicProductBySlug, type PublicProductDetail } from "@/services/store-catalog";

export class ServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
  }
}

export const CAMPAIGN_LABEL_MAX = 60;

const createCampaignLinkSchema = z.object({
  slug: z.string().trim().min(1, "Escolha o nome do link.").max(80),
  label: z.string().trim().min(1, "Dê um rótulo ao link.").max(CAMPAIGN_LABEL_MAX, `O rótulo tem no máximo ${CAMPAIGN_LABEL_MAX} caracteres.`),
  productId: z.uuid().nullable().optional(),
  userId: z.uuid(),
});
export type CreateCampaignLinkInput = z.input<typeof createCampaignLinkSchema>;

const updateCampaignLinkSchema = z.object({
  id: z.uuid(),
  label: z.string().trim().min(1, "Dê um rótulo ao link.").max(CAMPAIGN_LABEL_MAX).optional(),
  productId: z.uuid().nullable().optional(),
  isActive: z.boolean().optional(),
  userId: z.uuid(),
});
export type UpdateCampaignLinkInput = z.input<typeof updateCampaignLinkSchema>;

export type CampaignLink = {
  id: string;
  slug: string;
  label: string;
  productId: string | null;
  productName: string | null;
  productSlug: string | null;
  isActive: boolean;
  createdAt: Date;
  /** Funil do link: toques (pontes criadas), conversas (pontes consumidas) e pedidos (pontes com pedido). */
  taps: number;
  conversations: number;
  orders: number;
};

async function assertProduct(db: DbOrTx, productId: string): Promise<void> {
  const [row] = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.id, productId), sql`${products.deletedAt} IS NULL`))
    .limit(1);
  if (!row) throw new ServiceError("peca_nao_encontrada", "Essa peça não existe mais. Escolha outra.");
}

/** O slug normalizado ("Círio 2026" → "cirio-2026") ou o erro amigável. */
export function campaignSlugFrom(raw: string): string {
  const slug = normalizeCampaignSlug(raw);
  if (!slug) {
    throw new ServiceError(
      "slug_invalido",
      "O nome do link precisa ter de 2 a 40 letras, números ou hífens (ex.: dunas, cirio-2026).",
    );
  }
  return slug;
}

export async function createCampaignLink(db: DbOrTx, rawInput: CreateCampaignLinkInput): Promise<CampaignLink> {
  const input = createCampaignLinkSchema.parse(rawInput);
  const slug = campaignSlugFrom(input.slug);
  if (input.productId) await assertProduct(db, input.productId);

  const taken = new ServiceError("slug_em_uso", `Já existe um link "${slug}". Escolha outro nome.`);
  return db.transaction(async (tx) => {
    const [existing] = await tx.select({ id: campaignLinks.id }).from(campaignLinks).where(eq(campaignLinks.slug, slug)).limit(1);
    if (existing) throw taken;
    let row: typeof campaignLinks.$inferSelect;
    try {
      [row] = await tx
        .insert(campaignLinks)
        .values({ slug, label: input.label, productId: input.productId ?? null, createdBy: input.userId })
        .returning();
    } catch (error) {
      const code = (error as { code?: string; cause?: { code?: string } }).code ?? (error as { cause?: { code?: string } }).cause?.code;
      if (code === "23505") throw taken;
      throw error;
    }
    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: input.userId,
      action: "campaign_link.create",
      entityType: "campaign_link",
      entityId: row.id,
      after: { slug: row.slug, label: row.label, productId: row.productId },
    });
    const [link] = await listCampaignLinks(tx, { id: row.id });
    return link;
  });
}

/** Rótulo, peça ou ligado/desligado. O slug não muda: o link já foi colado por aí. */
export async function updateCampaignLink(db: DbOrTx, rawInput: UpdateCampaignLinkInput): Promise<CampaignLink> {
  const input = updateCampaignLinkSchema.parse(rawInput);
  if (input.productId) await assertProduct(db, input.productId);
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(campaignLinks).where(eq(campaignLinks.id, input.id)).limit(1);
    if (!before) throw new ServiceError("link_nao_encontrado", "Esse link não existe mais.");
    const patch = {
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.productId !== undefined ? { productId: input.productId } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    };
    if (Object.keys(patch).length > 0) {
      await tx
        .update(campaignLinks)
        .set({ ...patch, updatedAt: sql`now()` })
        .where(eq(campaignLinks.id, input.id));
      await tx.insert(auditLog).values({
        actorType: "user",
        actorId: input.userId,
        action: "campaign_link.update",
        entityType: "campaign_link",
        entityId: input.id,
        before: { label: before.label, productId: before.productId, isActive: before.isActive },
        after: patch,
      });
    }
    const [link] = await listCampaignLinks(tx, { id: input.id });
    return link;
  });
}

/** Todos os links (mais novos primeiro) com o funil de cada um; `id` filtra um só. */
export async function listCampaignLinks(db: DbOrTx, filter: { id?: string } = {}): Promise<CampaignLink[]> {
  const taps = db
    .select({
      campaignSlug: siteCarts.campaignSlug,
      taps: sql<number>`count(*)::int`.as("taps"),
      conversations: sql<number>`count(distinct ${siteCarts.conversationId})::int`.as("conversations"),
      orders: sql<number>`count(${siteCarts.orderId})::int`.as("orders"),
    })
    .from(siteCarts)
    .where(and(eq(siteCarts.source, "campaign"), isNotNull(siteCarts.campaignSlug)))
    .groupBy(siteCarts.campaignSlug)
    .as("taps");
  const rows = await db
    .select({
      id: campaignLinks.id,
      slug: campaignLinks.slug,
      label: campaignLinks.label,
      productId: campaignLinks.productId,
      productName: products.name,
      productSlug: products.slug,
      isActive: campaignLinks.isActive,
      createdAt: campaignLinks.createdAt,
      taps: sql<number | null>`${taps.taps}`,
      conversations: sql<number | null>`${taps.conversations}`,
      orders: sql<number | null>`${taps.orders}`,
    })
    .from(campaignLinks)
    .leftJoin(products, eq(products.id, campaignLinks.productId))
    .leftJoin(taps, eq(taps.campaignSlug, campaignLinks.slug))
    .where(filter.id ? eq(campaignLinks.id, filter.id) : undefined)
    .orderBy(desc(campaignLinks.createdAt), desc(campaignLinks.id));
  return rows.map((row) => ({
    ...row,
    taps: Number(row.taps ?? 0),
    conversations: Number(row.conversations ?? 0),
    orders: Number(row.orders ?? 0),
  }));
}

export type CampaignCurtain = {
  slug: string;
  label: string;
  isActive: boolean;
  /**
   * A peça do link (ativa, mesmo que ainda escondida pela janela VIP — a dona
   * a amarrou ao story de propósito). null quando não há peça ou ela saiu do ar.
   */
  product: PublicProductDetail | null;
  /** A página /produto/[slug] abre para o público agora (para o redirect do link desligado). */
  productPublicNow: boolean;
  sellerName: string;
  /** O WhatsApp da loja sem código — o botão de emergência da cortina. */
  plainWaUrl: string | null;
};

/** O que a página-cortina precisa; null quando o slug não existe. */
export async function getCampaignCurtain(db: DbOrTx, rawSlug: string): Promise<CampaignCurtain | null> {
  const slug = normalizeCampaignSlug(rawSlug);
  if (!slug) return null;
  const [row] = await db
    .select({ link: campaignLinks, productSlug: products.slug })
    .from(campaignLinks)
    .leftJoin(products, eq(products.id, campaignLinks.productId))
    .where(eq(campaignLinks.slug, slug))
    .limit(1);
  if (!row) return null;
  const [settings, product] = await Promise.all([
    loadBridgeSettings(db),
    row.productSlug ? getPublicProductBySlug(db, row.productSlug, undefined, { includeHidden: true }) : Promise.resolve(null),
  ]);
  return {
    slug: row.link.slug,
    label: row.link.label,
    isActive: row.link.isActive,
    product,
    productPublicNow: product?.publicNow === true,
    sellerName: settings.sellerName,
    plainWaUrl: plainBridgeUrl(settings),
  };
}

/**
 * O toque no link: grava a ponte (source 'campaign') e devolve o link do
 * WhatsApp com a mensagem pronta. null quando o link não existe ou está
 * desligado (a cortina manda a cliente à página da peça).
 */
export async function tapCampaignLink(db: DbOrTx, input: { slug: string }): Promise<SiteCartLink | null> {
  const slug = normalizeCampaignSlug(input.slug);
  if (!slug) return null;
  const [row] = await db
    .select({ isActive: campaignLinks.isActive, productSlug: products.slug })
    .from(campaignLinks)
    .leftJoin(products, eq(products.id, campaignLinks.productId))
    .where(eq(campaignLinks.slug, slug))
    .limit(1);
  if (!row || !row.isActive) return null;
  return createSiteCart(db, {
    source: "campaign",
    campaignSlug: slug,
    ...(row.productSlug ? { productSlug: row.productSlug, includeHiddenProduct: true } : {}),
  });
}
