// O cartão da edição na caixa: um por peça do pedido (não por unidade nem
// por tamanho), com a frase da curadora, como vestir em Belém, cuidados na
// umidade e o QR da peça. Gerado sob demanda pela tela do pedido — sem fila:
// é a dona esperando, na mesa de embalagem — e publicado em
// editions/<orderId>/<productId>.jpg (upsert: gerar de novo sobrescreve; o
// id, e não o slug, para a imagem continuar achável se a peça for renomeada).

import { eq, inArray } from "drizzle-orm";
import sharp from "sharp";
import { z } from "zod";

import type { FileStorage } from "@/adapters/storage";
import {
  editionFingerprintsOf,
  isEditionCardStale,
  parseEditionFingerprints,
  type EditionFingerprints,
} from "@/core/edition/fingerprint";
import { editionLayout } from "@/core/edition/layout";
import { editionTexts } from "@/core/edition/text";
import type { EditionCardData } from "@/core/edition/types";
import { categories, orderItems, orders, products, productVariants, settings } from "@/db/schema";
import { siteUrl } from "@/lib/site-url";
import type { DbOrTx } from "@/queue/enqueue";

export class ServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
  }
}

export type EditionCardRenderer = (data: EditionCardData) => Promise<Buffer>;
export const EDITION_CARD_JPEG_QUALITY = 88;

const orderIdSchema = z.object({ orderId: z.uuid() });

export function editionCardStoragePath(orderId: string, productId: string): string {
  return `editions/${orderId}/${productId}.jpg`;
}

/** URL pública com cache-busting pela última geração dos cartões. */
export function editionCardUrl(storage: FileStorage, path: string, at: Date): string {
  return `${storage.publicUrl(path)}?v=${at.getTime()}`;
}

/** "trivemaison.com.br" — o que sai escrito sob o QR. */
export function printedSiteAddress(): string {
  return siteUrl().replace(/^https?:\/\//, "");
}

/** A página da peça: no ar, ainda agendada (visível a partir de uma data) ou fora do ar. */
export type EditionPublicPage = "ok" | "agendada" | "fora_do_ar";

/** Uma peça do pedido, na ordem do recibo (código), com os textos prontos. */
export type EditionCardPlan = {
  productId: string;
  slug: string;
  name: string;
  data: EditionCardData;
  /** Os textos que não couberam inteiros no cartão. */
  titleTruncated: boolean;
  curatorTruncated: boolean;
  wearTruncated: boolean;
  careTruncated: boolean;
  /** Pictogramas de cuidado que ficaram de fora por falta de espaço. */
  careSymbolsDropped: number;
  publicPage: EditionPublicPage;
  /** Quando a página entra no ar, se ainda está agendada. */
  visibleFrom: Date | null;
};

/** Peça do pedido que fica sem cartão, e por quê. */
export type EditionCardSkip = { productId: string; name: string; reason: "nao_roupa" };

export type EditionCardsBasis = {
  orderId: string;
  orderNumber: number;
  /** Quando os cartões foram gerados pela última vez; null = ainda não. */
  editionCardsAt: Date | null;
  /** O que foi desenhado da última vez (hash por peça); null = ainda não. */
  editionCardsFingerprint: EditionFingerprints | null;
  /** Presente: o QR vai para a home, não para a página com preço. */
  isGift: boolean;
  cards: EditionCardPlan[];
  skipped: EditionCardSkip[];
};

/** O nome da edição, como sai na faixa do cartão. */
async function editionNameSetting(db: DbOrTx): Promise<string | null> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, "edition_name")).limit(1);
  return row && typeof row.value === "string" && row.value.trim() !== "" ? row.value.trim() : null;
}

export type EditionCardsPlan = { cards: EditionCardPlan[]; skipped: EditionCardSkip[] };

/**
 * As peças de cada pedido (uma por produto, mesmo com dois tamanhos ou duas
 * unidades), na ordem do recibo, com os textos de cada cartão — de uma vez
 * para vários pedidos (a mesa de embalagem) ou para um só (a tela). Peça sem
 * ficha usa o padrão da família — o cartão nunca sai com um quadro em
 * branco; o que não é roupa (caneca, caderno) fica sem cartão e é listado.
 */
export async function planEditionCardsByOrder(
  db: DbOrTx,
  targets: { id: string; isGift: boolean }[],
): Promise<Map<string, EditionCardsPlan>> {
  const plans = new Map<string, EditionCardsPlan>();
  if (targets.length === 0) return plans;
  for (const target of targets) plans.set(target.id, { cards: [], skipped: [] });
  const giftByOrder = new Map(targets.map((target) => [target.id, target.isGift]));

  const rows = await db
    .select({
      orderId: orderItems.orderId,
      productId: products.id,
      slug: products.slug,
      name: products.name,
      status: products.status,
      deletedAt: products.deletedAt,
      visibleFrom: products.visibleFrom,
      curatorNote: products.curatorNote,
      fitNotes: products.fitNotes,
      careNotes: products.careNotes,
      categoryName: categories.name,
    })
    .from(orderItems)
    .innerJoin(productVariants, eq(productVariants.id, orderItems.productVariantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .where(inArray(orderItems.orderId, [...plans.keys()]))
    // A mesma ordem do recibo (pelo código da variação): estável entre a
    // tela e a impressão, e igual ao papel que a cliente já viu.
    .orderBy(orderItems.orderId, orderItems.skuSnapshot, orderItems.id);

  const editionName = await editionNameSetting(db);
  const now = Date.now();
  const printedAddress = printedSiteAddress();
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.orderId}:${row.productId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const plan = plans.get(row.orderId);
    if (!plan) continue;
    const texts = editionTexts({
      productName: row.name,
      categoryName: row.categoryName,
      curatorNote: row.curatorNote,
      fitNotes: row.fitNotes,
      careNotes: row.careNotes,
    });
    if (!texts) {
      plan.skipped.push({ productId: row.productId, name: row.name, reason: "nao_roupa" });
      continue;
    }
    const isGift = giftByOrder.get(row.orderId) ?? false;
    const scheduled = row.visibleFrom !== null && row.visibleFrom.getTime() > now;
    const publicPage: EditionPublicPage =
      row.status !== "active" || row.deletedAt !== null ? "fora_do_ar" : scheduled ? "agendada" : "ok";
    // Presente vai "sem preço na embalagem": o QR leva à home, não à peça.
    const qrUrl = isGift ? siteUrl() : `${siteUrl()}/produto/${row.slug}`;
    // O orçamento de altura escolhe os corpos e, se preciso, encurta a frase.
    const layout = editionLayout({
      title: texts.title,
      curatorNote: texts.curatorNote,
      wearNote: texts.wearNote,
      careNote: texts.careNote,
      qrUrl,
    });
    plan.cards.push({
      productId: row.productId,
      slug: row.slug,
      name: row.name,
      titleTruncated: texts.titleTruncated,
      curatorTruncated: texts.curatorTruncated || layout.curatorShortened,
      wearTruncated: texts.wearTruncated,
      careTruncated: texts.careTruncated,
      careSymbolsDropped: texts.careSymbolsDropped,
      publicPage,
      visibleFrom: scheduled ? row.visibleFrom : null,
      data: {
        editionName,
        productName: texts.title,
        curatorNote: layout.curatorNote,
        wearNote: texts.wearNote,
        wearSource: texts.wearSource,
        careNote: texts.careNote,
        qrUrl,
        qrTarget: isGift ? "home" : "peca",
        printedAddress,
        layout: {
          titleSize: layout.titleSize,
          titleLines: layout.titleLines,
          quoteSize: layout.quoteSize,
          quoteLines: layout.quoteLines,
          bodySize: layout.bodySize,
          wearLines: layout.wearLines,
          careLines: layout.careLines,
          qrSize: layout.qrSize,
        },
      },
    });
  }
  return plans;
}

/** Os cartões gerados ficaram velhos? (algum diria outra coisa hoje, ou falta um). */
export function editionCardsStale(basis: {
  editionCardsFingerprint: EditionFingerprints | null;
  cards: EditionCardPlan[];
}): boolean {
  return basis.cards.some((card) => isEditionCardStale(basis.editionCardsFingerprint, card.productId, card.data));
}

export type EditionCardsStatus = {
  /** Quantas peças do pedido ganham cartão (0 = o link "cartões" não faz sentido). */
  cards: number;
  /** Os cartões gerados ficaram velhos. Pedido ainda sem cartões nunca está velho. */
  stale: boolean;
};

/**
 * Para vários pedidos de uma vez (a mesa de embalagem, a tela do pedido):
 * quantos cartões cada um tem e se os gerados ficaram velhos.
 */
export async function editionCardsStatusByOrder(
  db: DbOrTx,
  targets: { id: string; isGift: boolean; editionCardsAt: Date | null; editionCardsFingerprint: unknown }[],
): Promise<Map<string, EditionCardsStatus>> {
  const plans = await planEditionCardsByOrder(db, targets);
  const status = new Map<string, EditionCardsStatus>();
  for (const target of targets) {
    const plan = plans.get(target.id) ?? { cards: [], skipped: [] };
    const stored = target.editionCardsAt ? parseEditionFingerprints(target.editionCardsFingerprint) : null;
    status.set(target.id, {
      cards: plan.cards.length,
      stale: editionCardsStale({ editionCardsFingerprint: stored, cards: plan.cards }),
    });
  }
  return status;
}

/** O pedido e o plano dos cartões dele. */
export async function buildEditionCardsBasis(db: DbOrTx, orderId: string): Promise<EditionCardsBasis> {
  const id = z.uuid().parse(orderId);
  const [order] = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      editionCardsAt: orders.editionCardsAt,
      editionCardsFingerprint: orders.editionCardsFingerprint,
      isGift: orders.isGift,
    })
    .from(orders)
    .where(eq(orders.id, id))
    .limit(1);
  if (!order) throw new ServiceError("pedido_nao_encontrado", "Pedido não encontrado.");
  const plan = (await planEditionCardsByOrder(db, [order])).get(order.id) ?? { cards: [], skipped: [] };
  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    editionCardsAt: order.editionCardsAt,
    editionCardsFingerprint: order.editionCardsAt ? parseEditionFingerprints(order.editionCardsFingerprint) : null,
    isGift: order.isGift,
    cards: plan.cards,
    skipped: plan.skipped,
  };
}

export type PublishedEditionCard = {
  productId: string;
  slug: string;
  name: string;
  path: string;
  url: string;
};

/**
 * Desenha TODOS os cartões, depois sobe todos (upsert nos mesmos paths) e só
 * então carimba o pedido: uma peça que falha no meio não deixa cartão novo
 * ao lado de cartão velho sob o mesmo carimbo. Gerar de novo sobrescreve —
 * é o jeito de refletir uma nota da curadora escrita depois.
 */
export async function publishEditionCards(
  db: DbOrTx,
  storage: FileStorage,
  render: EditionCardRenderer,
  input: { orderId: string },
): Promise<{ at: Date; cards: PublishedEditionCard[]; skipped: EditionCardSkip[] }> {
  const { orderId } = orderIdSchema.parse(input);
  const at = new Date();
  const basis = await buildEditionCardsBasis(db, orderId);
  if (basis.cards.length === 0) {
    throw new ServiceError(
      "pedido_sem_pecas",
      basis.skipped.length > 0
        ? "Este pedido só tem itens que não são roupa: não há cartão da edição para ele."
        : "Este pedido não tem peças para o cartão.",
    );
  }
  const drawn: { card: EditionCardPlan; jpeg: Buffer }[] = [];
  for (const card of basis.cards) {
    try {
      const png = await render(card.data);
      drawn.push({ card, jpeg: await sharp(png).jpeg({ quality: EDITION_CARD_JPEG_QUALITY }).toBuffer() });
    } catch (error) {
      console.error(`[edition-cards] cartão de "${card.name}" (${card.productId}) falhou`, error);
      throw new ServiceError(
        "cartao_falhou",
        `Não consegui desenhar o cartão de “${card.name}”. Tente de novo; se continuar, avise quem cuida do sistema.`,
      );
    }
  }
  const published: PublishedEditionCard[] = [];
  for (const { card, jpeg } of drawn) {
    const path = editionCardStoragePath(basis.orderId, card.productId);
    await storage.upload({ path, data: jpeg, contentType: "image/jpeg" });
    published.push({
      productId: card.productId,
      slug: card.slug,
      name: card.name,
      path,
      url: editionCardUrl(storage, path, at),
    });
  }
  await db
    .update(orders)
    .set({ editionCardsAt: at, editionCardsFingerprint: editionFingerprintsOf(basis.cards), updatedAt: at })
    .where(eq(orders.id, basis.orderId));
  return { at, cards: published, skipped: basis.skipped };
}

export type EditionCardView = {
  productId: string;
  slug: string;
  name: string;
  /** Tem frase da curadora no cartão (a tela avisa quando não tem). */
  hasCuratorNote: boolean;
  titleTruncated: boolean;
  curatorTruncated: boolean;
  wearTruncated: boolean;
  careTruncated: boolean;
  careSymbolsDropped: number;
  publicPage: EditionPublicPage;
  visibleFrom: Date | null;
  /** O cartão diria outra coisa hoje (ficha, nota, nome da edição, presente): gere de novo. */
  stale: boolean;
  /** Imagem publicada; null enquanto os cartões não foram gerados. */
  url: string | null;
};

export type EditionCardsView = {
  orderNumber: number;
  at: Date | null;
  isGift: boolean;
  /** Algum cartão ficou velho: a tela pede "Gerar de novo". */
  stale: boolean;
  cards: EditionCardView[];
  skipped: EditionCardSkip[];
};

/** O que a tela mostra: as peças do pedido e, se já gerados, os cartões. */
export async function getEditionCards(db: DbOrTx, storage: FileStorage, orderId: string): Promise<EditionCardsView> {
  const basis = await buildEditionCardsBasis(db, orderId);
  const at = basis.editionCardsAt;
  const cards = basis.cards.map((card) => ({
    productId: card.productId,
    slug: card.slug,
    name: card.name,
    hasCuratorNote: card.data.curatorNote !== null,
    titleTruncated: card.titleTruncated,
    curatorTruncated: card.curatorTruncated,
    wearTruncated: card.wearTruncated,
    careTruncated: card.careTruncated,
    careSymbolsDropped: card.careSymbolsDropped,
    publicPage: card.publicPage,
    visibleFrom: card.visibleFrom,
    stale: isEditionCardStale(basis.editionCardsFingerprint, card.productId, card.data),
    // Só existe imagem para o que entrou na última geração; peça nova no plano fica sem url (e velha).
    url:
      at && basis.editionCardsFingerprint?.[card.productId] !== undefined
        ? editionCardUrl(storage, editionCardStoragePath(basis.orderId, card.productId), at)
        : null,
  }));
  return {
    orderNumber: basis.orderNumber,
    at,
    isGift: basis.isGift,
    stale: cards.some((card) => card.stale),
    cards,
    skipped: basis.skipped,
  };
}
