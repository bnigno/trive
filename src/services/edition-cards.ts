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
import { STORE_NAME_DEFAULT } from "@/lib/brand";
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

/** Uma peça do pedido, na ordem dos itens, com os textos do cartão prontos. */
export type EditionCardPlan = {
  productId: string;
  slug: string;
  name: string;
  data: EditionCardData;
};

export type EditionCardsBasis = {
  orderId: string;
  orderNumber: number;
  /** Quando os cartões foram gerados pela última vez; null = ainda não. */
  editionCardsAt: Date | null;
  cards: EditionCardPlan[];
};

/**
 * As peças do pedido (uma por produto, mesmo com dois tamanhos ou duas
 * unidades) e os textos de cada cartão. Peça sem ficha usa o padrão da
 * família — o cartão nunca sai com um quadro em branco.
 */
export async function buildEditionCardsBasis(db: DbOrTx, orderId: string): Promise<EditionCardsBasis> {
  const id = z.uuid().parse(orderId);
  const [order] = await db
    .select({ id: orders.id, orderNumber: orders.orderNumber, editionCardsAt: orders.editionCardsAt })
    .from(orders)
    .where(eq(orders.id, id))
    .limit(1);
  if (!order) throw new ServiceError("pedido_nao_encontrado", "Pedido não encontrado.");

  const rows = await db
    .select({
      itemId: orderItems.id,
      productId: products.id,
      slug: products.slug,
      name: products.name,
      curatorNote: products.curatorNote,
      fitNotes: products.fitNotes,
      careNotes: products.careNotes,
      categoryName: categories.name,
    })
    .from(orderItems)
    .innerJoin(productVariants, eq(productVariants.id, orderItems.productVariantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .where(eq(orderItems.orderId, id))
    // Os itens não têm carimbo próprio: a ordem do pedido é a do id (uuid),
    // estável entre a tela e a impressão.
    .orderBy(orderItems.id);

  const settingsMap = await getSettingsMap(db, ["store_name", "edition_name"]);
  const text = (key: string): string =>
    typeof settingsMap[key] === "string" ? (settingsMap[key] as string).trim() : "";
  const storeName = text("store_name") !== "" ? text("store_name") : STORE_NAME_DEFAULT;
  const editionName = text("edition_name") !== "" ? text("edition_name") : null;

  const seen = new Set<string>();
  const cards: EditionCardPlan[] = [];
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
    cards.push({
      productId: row.productId,
      slug: row.slug,
      name: row.name,
      data: {
        storeName,
        editionName,
        productName: row.name,
        curatorNote: texts.curatorNote,
        wearNote: texts.wearNote,
        careNote: texts.careNote,
        productUrl: `${siteUrl()}/produto/${row.slug}`,
      },
    });
  }
  return { orderId: order.id, orderNumber: order.orderNumber, editionCardsAt: order.editionCardsAt, cards };
}

export type PublishedEditionCard = {
  productId: string;
  slug: string;
  name: string;
  path: string;
  url: string;
};

/**
 * Desenha e publica um cartão por peça (upsert no mesmo path) e carimba o
 * pedido. Idempotente: gerar de novo sobrescreve as mesmas imagens — é o
 * jeito de refletir uma nota da curadora escrita depois.
 */
export async function publishEditionCards(
  db: DbOrTx,
  storage: FileStorage,
  render: EditionCardRenderer,
  input: { orderId: string },
): Promise<{ at: Date; cards: PublishedEditionCard[] }> {
  const { orderId } = orderIdSchema.parse(input);
  const basis = await buildEditionCardsBasis(db, orderId);
  if (basis.cards.length === 0) {
    throw new ServiceError("pedido_sem_pecas", "Este pedido não tem peças para o cartão.");
  }
  const published: PublishedEditionCard[] = [];
  const at = new Date();
  for (const card of basis.cards) {
    const png = await render(card.data);
    const jpeg = await sharp(png).jpeg({ quality: EDITION_CARD_JPEG_QUALITY }).toBuffer();
    const path = editionCardStoragePath(orderId, card.productId);
    await storage.upload({ path, data: jpeg, contentType: "image/jpeg" });
    published.push({
      productId: card.productId,
      slug: card.slug,
      name: card.name,
      path,
      url: editionCardUrl(storage, path, at),
    });
  }
  await db.update(orders).set({ editionCardsAt: at, updatedAt: at }).where(eq(orders.id, orderId));
  return { at, cards: published };
}

export type EditionCardView = {
  productId: string;
  slug: string;
  name: string;
  /** Tem frase da curadora no cartão (a tela avisa quando não tem). */
  hasCuratorNote: boolean;
  /** Imagem publicada; null enquanto os cartões não foram gerados. */
  url: string | null;
};

/** O que a tela mostra: as peças do pedido e, se já gerados, os cartões. */
export async function getEditionCards(
  db: DbOrTx,
  storage: FileStorage,
  orderId: string,
): Promise<{ orderNumber: number; at: Date | null; cards: EditionCardView[] }> {
  const basis = await buildEditionCardsBasis(db, orderId);
  const at = basis.editionCardsAt;
  return {
    orderNumber: basis.orderNumber,
    at,
    cards: basis.cards.map((card) => ({
      productId: card.productId,
      slug: card.slug,
      name: card.name,
      hasCuratorNote: card.data.curatorNote !== null,
      url: at ? editionCardUrl(storage, editionCardStoragePath(basis.orderId, card.productId), at) : null,
    })),
  };
}
