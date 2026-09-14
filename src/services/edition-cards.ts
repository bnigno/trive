// O cartão da edição na caixa: um por peça do pedido (não por unidade nem
// por tamanho), com a frase da curadora, como vestir em Belém, cuidados na
// umidade e o QR da peça — e, na primeira compra da cliente, a carta de
// estreia assinada pela dona, impressa antes dos cartões. Gerado pela fila
// ao pagar (order.edition_cards) e sob demanda pela tela do pedido; publicado
// em editions/<orderId>/<productId>.jpg e editions/<orderId>/carta-de-estreia.jpg
// (upsert: gerar de novo sobrescreve; o id, e não o slug, para a imagem
// continuar achável se a peça for renomeada).

import { and, eq, inArray } from "drizzle-orm";
import sharp from "sharp";
import { z } from "zod";

import type { FileStorage } from "@/adapters/storage";
import {
  COUNTED_STATUSES,
  countsAsPurchase,
  debutFirstName,
  fitDebutLetterToPaper,
  isFirstPurchase,
  normalizeDebutLetter,
  normalizeDebutSignature,
} from "@/core/edition/debut";
import {
  editionFingerprintsOf,
  isDebutLetterStale,
  isEditionCardStale,
  parseEditionFingerprints,
  type EditionFingerprints,
} from "@/core/edition/fingerprint";
import { editionLayout } from "@/core/edition/layout";
import { editionTexts } from "@/core/edition/text";
import type { DebutLetterData, EditionCardData } from "@/core/edition/types";
import { categories, customers, orderItems, orders, products, productVariants, settings } from "@/db/schema";
import { siteUrl } from "@/lib/site-url";
import { STORE_NAME_DEFAULT } from "@/lib/brand";
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
export type DebutLetterRenderer = (data: DebutLetterData) => Promise<Buffer>;
export type EditionRenderers = { card: EditionCardRenderer; letter: DebutLetterRenderer };
export const EDITION_CARD_JPEG_QUALITY = 88;

const orderIdSchema = z.object({ orderId: z.uuid() });

export function editionCardStoragePath(orderId: string, productId: string): string {
  return `editions/${orderId}/${productId}.jpg`;
}

export function debutLetterStoragePath(orderId: string): string {
  return `editions/${orderId}/carta-de-estreia.jpg`;
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
  /** Nenhum outro pedido pago desta cliente antes deste. */
  isFirstPurchase: boolean;
  /** A carta de estreia: só na primeira compra e só se a dona escreveu o texto. */
  letter: DebutLetterData | null;
  cards: EditionCardPlan[];
  skipped: EditionCardSkip[];
};

/** Os textos das configurações que entram nos desenhos (vazio = ""). */
async function editionSettings(db: DbOrTx): Promise<Record<string, string>> {
  const keys = ["edition_name", "store_name", "debut_letter_text", "debut_letter_signature"];
  const rows = await db.select({ key: settings.key, value: settings.value }).from(settings).where(inArray(settings.key, keys));
  const map: Record<string, string> = {};
  for (const row of rows) map[row.key] = typeof row.value === "string" ? row.value.trim() : "";
  return map;
}

/** O que a regra da estreia precisa saber de um pedido. */
export type DebutTarget = { id: string; customerId: string; paidAt: Date | null; isGift: boolean; customerName: string | null };

/**
 * Quantos pedidos pagos (em diante) cada cliente tinha ANTES de cada um
 * destes pedidos — pela ordem de PAGAMENTO (um pedido ainda não pago conta
 * tudo o que já foi pago). Presente não conta como compra dela. Uma consulta
 * para todos os pedidos (a mesa de embalagem chama com a lista inteira).
 */
export async function countPriorCountedOrdersByOrder(db: DbOrTx, targets: DebutTarget[]): Promise<Map<string, number>> {
  const prior = new Map<string, number>();
  if (targets.length === 0) return prior;
  const customerIds = [...new Set(targets.map((target) => target.customerId))];
  const rows = await db
    .select({ id: orders.id, customerId: orders.customerId, paidAt: orders.paidAt, status: orders.status, shippedAt: orders.shippedAt })
    .from(orders)
    .where(and(inArray(orders.customerId, customerIds), inArray(orders.status, [...COUNTED_STATUSES]), eq(orders.isGift, false)));
  // Reembolsado só conta se a caixa saiu (a regra mora em core/edition/debut).
  const counted = rows.filter((row) => countsAsPurchase(row));
  for (const target of targets) {
    const cutoff = target.paidAt?.getTime() ?? Number.POSITIVE_INFINITY;
    prior.set(
      target.id,
      counted.filter((row) => row.customerId === target.customerId && row.id !== target.id && (row.paidAt?.getTime() ?? 0) < cutoff).length,
    );
  }
  return prior;
}

/** Este pedido é a primeira compra da cliente? (para o selo no painel) */
export async function isFirstPurchaseOrder(db: DbOrTx, orderId: string): Promise<boolean> {
  const id = z.uuid().parse(orderId);
  const [order] = await db
    .select({ id: orders.id, customerId: orders.customerId, paidAt: orders.paidAt, isGift: orders.isGift })
    .from(orders)
    .where(eq(orders.id, id))
    .limit(1);
  if (!order) throw new ServiceError("pedido_nao_encontrado", "Pedido não encontrado.");
  const target = { ...order, customerName: null };
  const prior = (await countPriorCountedOrdersByOrder(db, [target])).get(order.id) ?? 0;
  return isFirstPurchase({ priorCountedOrders: prior, isGift: order.isGift });
}

/** A carta de estreia de um pedido, se for a primeira compra e a carta estiver escrita. */
function debutLetterFor(
  order: DebutTarget,
  priorCountedOrders: number,
  texts: Record<string, string>,
): { isFirstPurchase: boolean; letter: DebutLetterData | null } {
  const first = isFirstPurchase({ priorCountedOrders, isGift: order.isGift });
  const letterText = normalizeDebutLetter(texts["debut_letter_text"]);
  if (!first || !letterText) return { isFirstPurchase: first, letter: null };
  return {
    isFirstPurchase: true,
    letter: {
      recipientName: debutFirstName(order.customerName),
      // Um texto salvo antes da régua do papel é encurtado ao que cabe (a tela recusa os novos).
      text: fitDebutLetterToPaper(letterText).text,
      signature: normalizeDebutSignature(texts["debut_letter_signature"]),
      editionName: texts["edition_name"] ? texts["edition_name"] : null,
    },
  };
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

  const editionSettingsMap = await editionSettings(db);
  const editionName = editionSettingsMap["edition_name"] ? editionSettingsMap["edition_name"] : null;
  const storeName = editionSettingsMap["store_name"] || STORE_NAME_DEFAULT;
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
        storeName,
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

/** Os cartões (ou a carta) gerados ficaram velhos? (algum diria outra coisa hoje, ou falta um). */
export function editionCardsStale(basis: {
  editionCardsFingerprint: EditionFingerprints | null;
  cards: EditionCardPlan[];
  letter: DebutLetterData | null;
}): boolean {
  return (
    basis.cards.some((card) => isEditionCardStale(basis.editionCardsFingerprint, card.productId, card.data)) ||
    isDebutLetterStale(basis.editionCardsFingerprint, basis.letter)
  );
}

export type EditionCardsStatus = {
  /** Quantas peças do pedido ganham cartão. */
  cards: number;
  /** Primeira compra desta cliente (o selo). */
  isFirstPurchase: boolean;
  /** A carta de estreia sai neste pedido (primeira compra E carta escrita). */
  letter: boolean;
  /** Os cartões (ou a carta) gerados ficaram velhos. Pedido ainda sem geração nunca está velho. */
  stale: boolean;
};

/**
 * Para vários pedidos de uma vez (a mesa de embalagem, a tela do pedido):
 * quantos cartões cada um tem e se os gerados ficaram velhos.
 */
export async function editionCardsStatusByOrder(
  db: DbOrTx,
  targets: (DebutTarget & { editionCardsAt: Date | null; editionCardsFingerprint: unknown })[],
): Promise<Map<string, EditionCardsStatus>> {
  const status = new Map<string, EditionCardsStatus>();
  if (targets.length === 0) return status;
  const plans = await planEditionCardsByOrder(db, targets);
  const prior = await countPriorCountedOrdersByOrder(db, targets);
  const texts = await editionSettings(db);
  for (const target of targets) {
    const plan = plans.get(target.id) ?? { cards: [], skipped: [] };
    const { isFirstPurchase: first, letter } = debutLetterFor(target, prior.get(target.id) ?? 0, texts);
    const stored = target.editionCardsAt ? parseEditionFingerprints(target.editionCardsFingerprint) : null;
    status.set(target.id, {
      cards: plan.cards.length,
      isFirstPurchase: first,
      letter: letter !== null,
      stale: editionCardsStale({ editionCardsFingerprint: stored, cards: plan.cards, letter }),
    });
  }
  return status;
}

/** O pedido, o plano dos cartões dele e a carta (se couber). */
export async function buildEditionCardsBasis(db: DbOrTx, orderId: string): Promise<EditionCardsBasis> {
  const id = z.uuid().parse(orderId);
  const [order] = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      editionCardsAt: orders.editionCardsAt,
      editionCardsFingerprint: orders.editionCardsFingerprint,
      isGift: orders.isGift,
      customerId: orders.customerId,
      paidAt: orders.paidAt,
      customerName: customers.fullName,
    })
    .from(orders)
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(eq(orders.id, id))
    .limit(1);
  if (!order) throw new ServiceError("pedido_nao_encontrado", "Pedido não encontrado.");
  const plan = (await planEditionCardsByOrder(db, [order])).get(order.id) ?? { cards: [], skipped: [] };
  const prior = (await countPriorCountedOrdersByOrder(db, [order])).get(order.id) ?? 0;
  const { isFirstPurchase: first, letter } = debutLetterFor(order, prior, await editionSettings(db));
  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    editionCardsAt: order.editionCardsAt,
    editionCardsFingerprint: order.editionCardsAt ? parseEditionFingerprints(order.editionCardsFingerprint) : null,
    isGift: order.isGift,
    isFirstPurchase: first,
    letter,
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
 * Desenha a carta (se houver) e TODOS os cartões, depois sobe tudo (upsert
 * nos mesmos paths) e só então carimba o pedido: uma peça que falha no meio
 * não deixa cartão novo ao lado de cartão velho sob o mesmo carimbo. Gerar
 * de novo sobrescreve — é o jeito de refletir uma nota da curadora ou uma
 * carta escrita depois.
 */
export async function publishEditionCards(
  db: DbOrTx,
  storage: FileStorage,
  render: EditionRenderers,
  input: { orderId: string },
): Promise<{ at: Date; letterPath: string | null; cards: PublishedEditionCard[]; skipped: EditionCardSkip[] }> {
  const { orderId } = orderIdSchema.parse(input);
  const at = new Date();
  const basis = await buildEditionCardsBasis(db, orderId);
  // Sem cartão e sem carta não há o que desenhar; só a carta (primeira compra
  // de uma caneca, por exemplo) ainda sai.
  if (basis.cards.length === 0 && !basis.letter) {
    throw new ServiceError(
      "pedido_sem_pecas",
      basis.skipped.length > 0
        ? "Este pedido só tem itens que não são roupa: não há cartão da edição para ele."
        : "Este pedido não tem peças para o cartão.",
    );
  }
  let letterJpeg: Buffer | null = null;
  if (basis.letter) {
    try {
      const png = await render.letter(basis.letter);
      letterJpeg = await sharp(png).jpeg({ quality: EDITION_CARD_JPEG_QUALITY }).toBuffer();
    } catch (error) {
      console.error(`[edition-cards] carta de estreia do pedido ${basis.orderId} falhou`, error);
      throw new ServiceError(
        "cartao_falhou",
        "Não consegui desenhar a carta de estreia. Tente de novo; se continuar, avise quem cuida do sistema.",
      );
    }
  }
  const drawn: { card: EditionCardPlan; jpeg: Buffer }[] = [];
  for (const card of basis.cards) {
    try {
      const png = await render.card(card.data);
      drawn.push({ card, jpeg: await sharp(png).jpeg({ quality: EDITION_CARD_JPEG_QUALITY }).toBuffer() });
    } catch (error) {
      console.error(`[edition-cards] cartão de "${card.name}" (${card.productId}) falhou`, error);
      throw new ServiceError(
        "cartao_falhou",
        `Não consegui desenhar o cartão de “${card.name}”. Tente de novo; se continuar, avise quem cuida do sistema.`,
      );
    }
  }
  let letterPath: string | null = null;
  if (letterJpeg) {
    letterPath = debutLetterStoragePath(basis.orderId);
    await storage.upload({ path: letterPath, data: letterJpeg, contentType: "image/jpeg" });
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
    .set({ editionCardsAt: at, editionCardsFingerprint: editionFingerprintsOf(basis.cards, basis.letter), updatedAt: at })
    .where(eq(orders.id, basis.orderId));
  return { at, letterPath, cards: published, skipped: basis.skipped };
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
  isFirstPurchase: boolean;
  /** null = não é primeira compra ou a carta ainda não foi escrita nas configurações. */
  letter: { recipientName: string; url: string | null; stale: boolean } | null;
  /** Algum cartão (ou a carta) ficou velho: a tela pede "Gerar de novo". */
  stale: boolean;
  cards: EditionCardView[];
  skipped: EditionCardSkip[];
};

/** O que a tela mostra: a carta (se couber), as peças do pedido e, se já gerados, as imagens. */
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
  const letterStale = isDebutLetterStale(basis.editionCardsFingerprint, basis.letter);
  return {
    orderNumber: basis.orderNumber,
    at,
    isGift: basis.isGift,
    isFirstPurchase: basis.isFirstPurchase,
    letter: basis.letter
      ? {
          recipientName: basis.letter.recipientName,
          // Carta escrita depois da geração: ainda não existe imagem dela — a tela pede "gerar de novo".
          url: at && basis.editionCardsFingerprint?.carta ? editionCardUrl(storage, debutLetterStoragePath(basis.orderId), at) : null,
          stale: letterStale,
        }
      : null,
    stale: cards.some((card) => card.stale) || letterStale,
    cards,
    skipped: basis.skipped,
  };
}
