// O cartão da edição na caixa: um por peça do pedido (não por unidade nem
// por tamanho), com a frase da curadora, como vestir em Belém, cuidados na
// umidade e o QR da peça. Gerado sob demanda pela tela do pedido — sem fila:
// é a dona esperando, na mesa de embalagem — e publicado em
// editions/<orderId>/<productId>.jpg (upsert: gerar de novo sobrescreve; o
// id, e não o slug, para a imagem continuar achável se a peça for renomeada).

import { eq } from "drizzle-orm";
import sharp from "sharp";
import { z } from "zod";

import type { FileStorage } from "@/adapters/storage";
import { editionTexts } from "@/core/edition/text";
import type { EditionCardData } from "@/core/edition/types";
import { categories, orderItems, orders, products, productVariants } from "@/db/schema";
import { siteUrl } from "@/lib/site-url";
import type { DbOrTx } from "@/queue/enqueue";
import { getSettingsMap } from "@/services/settings";

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

/** Uma peça do pedido, na ordem do recibo (código), com os textos prontos. */
export type EditionCardPlan = {
  productId: string;
  slug: string;
  name: string;
  data: EditionCardData;
  /** A frase da curadora ou os cuidados não couberam inteiros no cartão. */
  curatorTruncated: boolean;
  careTruncated: boolean;
  /** A página da peça está no ar (ativa, visível, não excluída): o QR funciona. */
  publicPage: boolean;
  /** Última mudança da ficha ou da nota — para saber se o cartão gerado ficou velho. */
  changedAt: Date;
};

/** Peça do pedido que fica sem cartão, e por quê. */
export type EditionCardSkip = { productId: string; name: string; reason: "nao_roupa" };

export type EditionCardsBasis = {
  orderId: string;
  orderNumber: number;
  /** Quando os cartões foram gerados pela última vez; null = ainda não. */
  editionCardsAt: Date | null;
  /** Presente: o QR vai para a home, não para a página com preço. */
  isGift: boolean;
  cards: EditionCardPlan[];
  skipped: EditionCardSkip[];
};

/**
 * As peças do pedido (uma por produto, mesmo com dois tamanhos ou duas
 * unidades), na ordem do recibo, com os textos de cada cartão. Peça sem ficha
 * usa o padrão da família — o cartão nunca sai com um quadro em branco; o que
 * não é roupa (caneca, caderno) fica sem cartão e é listado.
 */
export async function buildEditionCardsBasis(db: DbOrTx, orderId: string): Promise<EditionCardsBasis> {
  const id = z.uuid().parse(orderId);
  const [order] = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      editionCardsAt: orders.editionCardsAt,
      isGift: orders.isGift,
    })
    .from(orders)
    .where(eq(orders.id, id))
    .limit(1);
  if (!order) throw new ServiceError("pedido_nao_encontrado", "Pedido não encontrado.");

  const rows = await db
    .select({
      productId: products.id,
      slug: products.slug,
      name: products.name,
      status: products.status,
      deletedAt: products.deletedAt,
      visibleFrom: products.visibleFrom,
      updatedAt: products.updatedAt,
      curatorNoteUpdatedAt: products.curatorNoteUpdatedAt,
      curatorNote: products.curatorNote,
      fitNotes: products.fitNotes,
      careNotes: products.careNotes,
      categoryName: categories.name,
    })
    .from(orderItems)
    .innerJoin(productVariants, eq(productVariants.id, orderItems.productVariantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .where(eq(orderItems.orderId, order.id))
    // A mesma ordem do recibo (pelo código da variação): estável entre a
    // tela e a impressão, e igual ao papel que a cliente já viu.
    .orderBy(orderItems.skuSnapshot, orderItems.id);

  const settingsMap = await getSettingsMap(db, ["edition_name"]);
  const editionRaw = settingsMap["edition_name"];
  const editionName = typeof editionRaw === "string" && editionRaw.trim() !== "" ? editionRaw.trim() : null;
  const now = Date.now();
  const printedAddress = printedSiteAddress();

  const seen = new Set<string>();
  const cards: EditionCardPlan[] = [];
  const skipped: EditionCardSkip[] = [];
  for (const row of rows) {
    if (seen.has(row.productId)) continue;
    seen.add(row.productId);
    const texts = editionTexts({
      productName: row.name,
      categoryName: row.categoryName,
      curatorNote: row.curatorNote,
      fitNotes: row.fitNotes,
      careNotes: row.careNotes,
    });
    if (!texts) {
      skipped.push({ productId: row.productId, name: row.name, reason: "nao_roupa" });
      continue;
    }
    const publicPage =
      row.status === "active" &&
      row.deletedAt === null &&
      (row.visibleFrom === null || row.visibleFrom.getTime() <= now);
    cards.push({
      productId: row.productId,
      slug: row.slug,
      name: row.name,
      curatorTruncated: texts.curatorTruncated,
      careTruncated: texts.careTruncated,
      publicPage,
      changedAt: new Date(Math.max(row.updatedAt.getTime(), row.curatorNoteUpdatedAt?.getTime() ?? 0)),
      data: {
        editionName,
        productName: row.name,
        curatorNote: texts.curatorNote,
        wearNote: texts.wearNote,
        wearSource: texts.wearSource,
        careNote: texts.careNote,
        // Presente vai "sem preço na embalagem": o QR leva à home, não à peça.
        qrUrl: order.isGift ? siteUrl() : `${siteUrl()}/produto/${row.slug}`,
        printedAddress,
      },
    });
  }
  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    editionCardsAt: order.editionCardsAt,
    isGift: order.isGift,
    cards,
    skipped,
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
  const at = new Date();
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
  await db.update(orders).set({ editionCardsAt: at, updatedAt: at }).where(eq(orders.id, basis.orderId));
  return { at, cards: published, skipped: basis.skipped };
}

export type EditionCardView = {
  productId: string;
  slug: string;
  name: string;
  /** Tem frase da curadora no cartão (a tela avisa quando não tem). */
  hasCuratorNote: boolean;
  curatorTruncated: boolean;
  careTruncated: boolean;
  /** A página da peça está no ar: o QR funciona. */
  publicPage: boolean;
  /** A ficha ou a nota mudou depois de o cartão ser gerado. */
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
    curatorTruncated: card.curatorTruncated,
    careTruncated: card.careTruncated,
    publicPage: card.publicPage,
    stale: at !== null && card.changedAt.getTime() > at.getTime(),
    url: at ? editionCardUrl(storage, editionCardStoragePath(basis.orderId, card.productId), at) : null,
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
