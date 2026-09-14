// "Quem já vestiu": a foto que a cliente mandou usando a peça. A Lia registra
// no turno (só o banco + a fila, na mesma transação); a fila baixa a foto
// original da Z-API, normaliza (rotação, ≤ 1600 px, JPEG sem EXIF), desenha
// o cartão "Ana veste Longo Dunas", manda para ela e faz a pergunta tocável
// de consentimento. Só com o "sim" dela E a aprovação da dona a foto entra
// na vitrine; ela retira quando quiser (retirar_minha_foto, "esquecer
// minha cartela"), a dona também.
import { and, count, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import sharp from "sharp";
import { z } from "zod";

import { getFileStorage, type FileStorage } from "@/adapters/storage";
import type { MessagingProvider } from "@/adapters/zapi";
import { cardFrameSize, type CustomerLookCardData } from "@/core/cards/types";
import {
  CUSTOMER_LOOK_EYEBROW,
  LOOK_CONSENT_BUTTON,
  LOOK_CONSENT_TITLE,
  isLookPublic,
  lookCardCaption,
  lookCardTitle,
  lookConsentAckText,
  lookConsentBody,
  lookConsentOptions,
  type LookConsentAnswer,
} from "@/core/looks/consent";
import { auditLog, customerLooks, customers, products, settings, waMessages } from "@/db/schema";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";
import { loadCardPhotoDataUrl, type CardRenderer } from "@/services/bot-cards";
import { getStoreName } from "@/services/settings";
import { INBOUND_IMAGE_MAX_BYTES } from "@/services/wa-media";
import { sendMediaMessage, type SendWaMessageResult, type WaSkipReason } from "@/services/wa-messaging";

export const CUSTOMER_LOOK_CARD_EVENT = "wa.customer_look_card";
export const STORE_REVALIDATE_EVENT = "store.revalidate";
/** A foto continua "do turno" por meia hora: "foto → a Lia pergunta qual peça → ela responde" ainda registra. */
export const LOOK_PHOTO_WINDOW_MS = 30 * 60_000;
export const LOOK_PHOTO_MAX_EDGE = 1600;
export const LOOK_PHOTO_JPEG_QUALITY = 85;
export const LOOK_CARD_JPEG_QUALITY = 85;
export const PUBLIC_LOOKS_PER_PRODUCT = 8;

export const customerLookCardPayloadSchema = z.object({ lookId: z.uuid() });

export function lookPhotoStoragePath(lookId: string): string {
  return `looks/${lookId}/photo.jpg`;
}

export function lookCardStoragePath(lookId: string): string {
  return `looks/${lookId}/card.jpg`;
}

/** Setting customer_looks_enabled: ausente = ligado. */
export async function isCustomerLooksEnabled(db: DbOrTx): Promise<boolean> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, "customer_looks_enabled")).limit(1);
  return row?.value !== false;
}

/**
 * No turno da Lia (dentro da transação): a linha nasce apontando para a
 * mensagem com a foto e a fila faz o resto. A mesma foto registrada duas
 * vezes (a Lia chamou de novo, retry do turno) devolve a linha que já
 * existe — UNIQUE parcial por mensagem, nada de segundo cartão.
 */
export async function registerCustomerLook(
  tx: DbOrTx,
  input: {
    customerId: string | null;
    phoneE164: string;
    productId: string;
    productVariantId?: string | null;
    orderId?: string | null;
    displayName: string;
    photoWaMessageId: string;
    now: Date;
  },
): Promise<{ lookId: string; created: boolean }> {
  const [existing] = await tx
    .select({ id: customerLooks.id })
    .from(customerLooks)
    .where(eq(customerLooks.photoWaMessageId, input.photoWaMessageId))
    .limit(1);
  if (existing) return { lookId: existing.id, created: false };
  const [row] = await tx
    .insert(customerLooks)
    .values({
      customerId: input.customerId,
      phoneE164: input.phoneE164,
      productId: input.productId,
      productVariantId: input.productVariantId ?? null,
      orderId: input.orderId ?? null,
      displayName: input.displayName,
      photoWaMessageId: input.photoWaMessageId,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoNothing({ target: customerLooks.photoWaMessageId, where: sql`${customerLooks.photoWaMessageId} IS NOT NULL` })
    .returning({ id: customerLooks.id });
  if (!row) {
    const [raced] = await tx.select({ id: customerLooks.id }).from(customerLooks).where(eq(customerLooks.photoWaMessageId, input.photoWaMessageId)).limit(1);
    return { lookId: raced.id, created: false };
  }
  await enqueueOutboxEvent(tx, {
    eventType: CUSTOMER_LOOK_CARD_EVENT,
    dedupeKey: `wa.look_card:${row.id}`,
    aggregateType: "customer_look",
    aggregateId: row.id,
    payload: { lookId: row.id },
  });
  return { lookId: row.id, created: true };
}

/** A vitrine da peça é ISR: quem tira uma foto da página avisa pela fila (revalidatePath no runtime do Next). */
async function enqueueStoreRevalidate(db: DbOrTx, input: { lookId: string; productSlug: string; reason: string; now: Date }): Promise<void> {
  await enqueueOutboxEvent(db, {
    eventType: STORE_REVALIDATE_EVENT,
    dedupeKey: `store.revalidate:look:${input.lookId}:${input.reason}:${input.now.getTime()}`,
    aggregateType: "customer_look",
    aggregateId: input.lookId,
    payload: { paths: [`/produto/${input.productSlug}`] },
  });
}

export type CustomerLookCardResult =
  | { sent: true; cardUrl: string; consent: SendWaMessageResult }
  | { skipped: "foto_inexistente" | "sem_produto" | "foto_indisponivel" | "retirada" | WaSkipReason };

/** Foto da cliente pronta para guardar: orientação pelo EXIF, ≤ 1600 px, JPEG sem metadados. */
export async function normalizeLookPhoto(data: Buffer): Promise<Buffer> {
  return sharp(data, { limitInputPixels: 50_000_000 })
    .rotate()
    .resize({ width: LOOK_PHOTO_MAX_EDGE, height: LOOK_PHOTO_MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: LOOK_PHOTO_JPEG_QUALITY })
    .toBuffer();
}

/**
 * Handler de wa.customer_look_card: baixa a foto (uma vez), desenha o cartão
 * (uma vez), manda o cartão e a pergunta de consentimento (dedupe por foto:
 * a reentrada não manda de novo). Erro ao baixar/ler/desenhar RELANÇA — a
 * política da fila tenta de novo (Z-API ou Storage instáveis) e, esgotada,
 * o evento fica visível em /admin/fila; a linha sem foto nunca é pública.
 */
export async function renderAndSendCustomerLookCard(
  db: DbOrTx,
  provider: MessagingProvider,
  storage: FileStorage,
  render: CardRenderer,
  input: z.input<typeof customerLookCardPayloadSchema>,
  clock: { now?: () => Date } = {},
): Promise<CustomerLookCardResult> {
  const { lookId } = customerLookCardPayloadSchema.parse(input);
  const now = clock.now ?? (() => new Date());
  const [look] = await db
    .select({
      id: customerLooks.id,
      customerId: customerLooks.customerId,
      phoneE164: customerLooks.phoneE164,
      displayName: customerLooks.displayName,
      photoPath: customerLooks.photoPath,
      cardPath: customerLooks.cardPath,
      revokedAt: customerLooks.revokedAt,
      photoUrl: waMessages.mediaUrl,
      productName: products.name,
      productDeletedAt: products.deletedAt,
    })
    .from(customerLooks)
    .innerJoin(products, eq(products.id, customerLooks.productId))
    .leftJoin(waMessages, eq(waMessages.id, customerLooks.photoWaMessageId))
    .where(eq(customerLooks.id, lookId))
    .limit(1);
  if (!look) return { skipped: "foto_inexistente" };
  if (look.productDeletedAt) return { skipped: "sem_produto" };
  if (look.revokedAt) return { skipped: "retirada" };

  let photoPath = look.photoPath;
  if (!photoPath) {
    if (!look.photoUrl) return { skipped: "foto_indisponivel" };
    const media = await provider.downloadMedia({ url: look.photoUrl, maxBytes: INBOUND_IMAGE_MAX_BYTES });
    const jpeg = await normalizeLookPhoto(media.data);
    photoPath = lookPhotoStoragePath(lookId);
    await storage.upload({ path: photoPath, data: jpeg, contentType: "image/jpeg" });
    await db.update(customerLooks).set({ photoPath, updatedAt: now() }).where(eq(customerLooks.id, lookId));
  }

  let cardPath = look.cardPath;
  if (!cardPath) {
    // A foto acabou de ser gravada: não abrir é falha transitória do Storage — relança.
    const photoDataUrl = await loadCardPhotoDataUrl(storage, photoPath, cardFrameSize("customer_look", "hero", 1));
    const storeName = await getStoreName(db);
    const data: CustomerLookCardData = {
      kind: "customer_look",
      storeName,
      eyebrow: CUSTOMER_LOOK_EYEBROW,
      title: lookCardTitle(look.displayName, look.productName),
      productName: look.productName,
      photoDataUrl,
      caption: `Obrigada por vestir a ${storeName}.`,
    };
    const png = await render(data);
    const card = await sharp(png).jpeg({ quality: LOOK_CARD_JPEG_QUALITY }).toBuffer();
    cardPath = lookCardStoragePath(lookId);
    await storage.upload({ path: cardPath, data: card, contentType: "image/jpeg" });
    await db.update(customerLooks).set({ cardPath, updatedAt: now() }).where(eq(customerLooks.id, lookId));
  }

  // O cartão é resposta à foto que ela acabou de mandar: não exige opt-in de
  // marketing nem janela — é a conversa dela.
  const cardUrl = storage.publicUrl(cardPath);
  const image = await sendMediaMessage(db, provider, {
    kind: "image",
    imageUrl: cardUrl,
    body: lookCardCaption(look.displayName, look.productName),
    phoneE164: look.phoneE164,
    ...(look.customerId ? { customerId: look.customerId } : {}),
    dedupeKey: `wa.look_card_img:${lookId}`,
    requireOptIn: false,
  });
  // "ja_enviado" = a reentrada da fila: o cartão já foi; segue para a pergunta.
  if ("skipped" in image && image.skipped !== "ja_enviado") return { skipped: image.skipped };
  const consent = await sendMediaMessage(db, provider, {
    kind: "option_list",
    body: lookConsentBody(look.productName),
    optionList: { title: LOOK_CONSENT_TITLE, buttonLabel: LOOK_CONSENT_BUTTON, options: lookConsentOptions(lookId) },
    phoneE164: look.phoneE164,
    ...(look.customerId ? { customerId: look.customerId } : {}),
    dedupeKey: `wa.look_consent_ask:${lookId}`,
    requireOptIn: false,
  });
  return { sent: true, cardUrl, consent };
}

export type LookConsentContext = { lookId: string; productName: string; answer: LookConsentAnswer; changed: boolean };

/**
 * O toque chegou (webhook): grava a resposta — só do telefone que recebeu a
 * pergunta — e enfileira a confirmação curta. Se ela mudar de ideia (toca a
 * outra opção depois), a ÚLTIMA vale: "Prefiro que não" depois do "sim" tira
 * a foto da página na hora, mesmo já aprovada. Devolve o contexto para o
 * histórico; null = nada gravado (telefone diferente, mesmo toque de novo,
 * foto retirada).
 */
export async function recordLookConsent(
  tx: DbOrTx,
  input: { lookId: string; phoneE164: string; answer: LookConsentAnswer; waMessageId: string; now: Date },
): Promise<LookConsentContext | null> {
  const [look] = await tx
    .select({
      id: customerLooks.id,
      phoneE164: customerLooks.phoneE164,
      consentAnswer: customerLooks.consentAnswer,
      approvedAt: customerLooks.approvedAt,
      rejectedAt: customerLooks.rejectedAt,
      revokedAt: customerLooks.revokedAt,
      productName: products.name,
      productSlug: products.slug,
    })
    .from(customerLooks)
    .innerJoin(products, eq(products.id, customerLooks.productId))
    .where(eq(customerLooks.id, input.lookId))
    .limit(1);
  if (!look || look.phoneE164 !== input.phoneE164 || look.consentAnswer === input.answer || look.revokedAt) return null;
  const wasPublic = isLookPublic(look);
  const updated = await tx
    .update(customerLooks)
    .set({ consentAnswer: input.answer, consentAt: input.now, consentWaMessageId: input.waMessageId, updatedAt: input.now })
    .where(and(eq(customerLooks.id, input.lookId), isNull(customerLooks.revokedAt)))
    .returning({ id: customerLooks.id });
  if (updated.length === 0) return null;
  const changed = look.consentAnswer !== null;
  // Uma confirmação por resposta (a mudança de ideia ganha a sua).
  const dedupeKey = `wa.look_consent_ack:${input.lookId}:${input.answer}`;
  await enqueueOutboxEvent(tx, {
    eventType: "wa.send",
    dedupeKey,
    aggregateType: "customer_look",
    aggregateId: input.lookId,
    payload: { templateKey: null, phoneE164: input.phoneE164, body: lookConsentAckText(input.answer, changed), dedupeKey },
  });
  if (wasPublic && input.answer === "nao") await enqueueStoreRevalidate(tx, { lookId: input.lookId, productSlug: look.productSlug, reason: "consent", now: input.now });
  return { lookId: input.lookId, productName: look.productName, answer: input.answer, changed };
}

/** Retirada de verdade: os arquivos saem do bucket público (melhor esforço) e os caminhos zeram. */
async function purgeLookFiles(db: DbOrTx, storage: FileStorage, look: { id: string; photoPath: string | null; cardPath: string | null }, now: Date): Promise<void> {
  for (const path of [look.photoPath, look.cardPath]) {
    if (!path) continue;
    try {
      await storage.remove(path);
    } catch (error) {
      console.warn(`[customer-looks] não apagou ${path}:`, error instanceof Error ? error.message : error);
    }
  }
  await db.update(customerLooks).set({ photoPath: null, cardPath: null, updatedAt: now }).where(eq(customerLooks.id, look.id));
}

async function audit(db: DbOrTx, input: { action: string; lookId: string; userId?: string | null; source?: string; after: Record<string, unknown> }): Promise<void> {
  await db.insert(auditLog).values({
    actorType: input.userId ? "user" : input.source === "customer" || input.source === "lia" ? "customer" : "system",
    actorId: input.userId ?? null,
    action: input.action,
    entityType: "customer_look",
    entityId: input.lookId,
    after: input.after,
  });
}

/** A dona aprova: a foto entra na vitrine (só com o "sim" dela; recusada e retirada são finais). */
export async function approveCustomerLook(db: DbOrTx, input: { lookId: string; userId: string; now?: Date }): Promise<{ approved: boolean }> {
  const now = input.now ?? new Date();
  const updated = await db
    .update(customerLooks)
    .set({ approvedAt: now, approvedBy: input.userId, updatedAt: now })
    .where(and(eq(customerLooks.id, input.lookId), eq(customerLooks.consentAnswer, "sim"), isNull(customerLooks.revokedAt), isNull(customerLooks.rejectedAt), isNull(customerLooks.approvedAt)))
    .returning({ id: customerLooks.id });
  if (updated.length === 0) return { approved: false };
  await audit(db, { action: "look.approve", lookId: input.lookId, userId: input.userId, after: { approvedAt: now.toISOString() } });
  return { approved: true };
}

/** A dona recusa: não entra na vitrine (a cliente fica com o cartão). */
export async function rejectCustomerLook(db: DbOrTx, input: { lookId: string; userId: string; now?: Date }): Promise<{ rejected: boolean }> {
  const now = input.now ?? new Date();
  const updated = await db
    .update(customerLooks)
    .set({ rejectedAt: now, updatedAt: now })
    .where(and(eq(customerLooks.id, input.lookId), isNull(customerLooks.approvedAt), isNull(customerLooks.rejectedAt), isNull(customerLooks.revokedAt)))
    .returning({ id: customerLooks.id });
  if (updated.length === 0) return { rejected: false };
  await audit(db, { action: "look.reject", lookId: input.lookId, userId: input.userId, after: { rejectedAt: now.toISOString() } });
  return { rejected: true };
}

/** Retirada de uma foto (dona ou sistema): some da vitrine e do bucket para sempre. */
export async function revokeCustomerLook(
  db: DbOrTx,
  input: { lookId: string; userId?: string; source: "owner" | "customer" | "lia" | "forget"; now?: Date },
  storage: FileStorage = getFileStorage(),
): Promise<{ revoked: boolean }> {
  const now = input.now ?? new Date();
  const updated = await db
    .update(customerLooks)
    .set({ revokedAt: now, revokedBy: input.source, updatedAt: now })
    .where(and(eq(customerLooks.id, input.lookId), isNull(customerLooks.revokedAt)))
    .returning({ id: customerLooks.id, photoPath: customerLooks.photoPath, cardPath: customerLooks.cardPath, consentAnswer: customerLooks.consentAnswer, approvedAt: customerLooks.approvedAt, rejectedAt: customerLooks.rejectedAt, productId: customerLooks.productId });
  if (updated.length === 0) return { revoked: false };
  await audit(db, { action: "look.revoke", lookId: input.lookId, userId: input.userId ?? null, source: input.source, after: { revokedAt: now.toISOString(), by: input.source } });
  await purgeLookFiles(db, storage, updated[0], now);
  if (isLookPublic({ ...updated[0], revokedAt: null })) {
    const [product] = await db.select({ slug: products.slug }).from(products).where(eq(products.id, updated[0].productId)).limit(1);
    if (product) await enqueueStoreRevalidate(db, { lookId: input.lookId, productSlug: product.slug, reason: "revoke", now });
  }
  return { revoked: true };
}

/**
 * A cliente pede para retirar (pela Lia) ou "esquecer minha cartela": todas
 * as fotos dela saem — pelo telefone E pelo cadastro (ela pode ter trocado
 * de número) — da vitrine e do bucket. `wasPublic` = quantas estavam na
 * página de fato.
 */
export async function revokeCustomerLooksByPhone(
  db: DbOrTx,
  input: { phoneE164: string; customerId?: string | null; source: "customer" | "lia" | "forget"; now?: Date },
  storage: FileStorage = getFileStorage(),
): Promise<{ revoked: number; wasPublic: number }> {
  const now = input.now ?? new Date();
  const who = input.customerId ? or(eq(customerLooks.phoneE164, input.phoneE164), eq(customerLooks.customerId, input.customerId)) : eq(customerLooks.phoneE164, input.phoneE164);
  const updated = await db
    .update(customerLooks)
    .set({ revokedAt: now, revokedBy: input.source, updatedAt: now })
    .where(and(who, isNull(customerLooks.revokedAt)))
    .returning({ id: customerLooks.id, photoPath: customerLooks.photoPath, cardPath: customerLooks.cardPath, consentAnswer: customerLooks.consentAnswer, approvedAt: customerLooks.approvedAt, rejectedAt: customerLooks.rejectedAt, productId: customerLooks.productId });
  let wasPublic = 0;
  for (const row of updated) {
    await audit(db, { action: "look.revoke", lookId: row.id, source: input.source, after: { revokedAt: now.toISOString(), by: input.source } });
    await purgeLookFiles(db, storage, row, now);
    if (isLookPublic({ ...row, revokedAt: null })) {
      wasPublic += 1;
      const [product] = await db.select({ slug: products.slug }).from(products).where(eq(products.id, row.productId)).limit(1);
      if (product) await enqueueStoreRevalidate(db, { lookId: row.id, productSlug: product.slug, reason: "revoke", now });
    }
  }
  return { revoked: updated.length, wasPublic };
}

export interface CustomerLookRow {
  id: string;
  displayName: string;
  phoneE164: string;
  customerName: string | null;
  productId: string;
  productName: string;
  productSlug: string;
  photoPath: string | null;
  cardPath: string | null;
  consentAnswer: string | null;
  consentAt: Date | null;
  approvedAt: Date | null;
  rejectedAt: Date | null;
  revokedAt: Date | null;
  revokedBy: string | null;
  orderId: string | null;
  createdAt: Date;
  /** Derivado: está na vitrine agora. */
  isPublic: boolean;
}

function toRow(row: Omit<CustomerLookRow, "isPublic">): CustomerLookRow {
  return { ...row, isPublic: isLookPublic(row) };
}

const lookRowSelect = {
  id: customerLooks.id,
  displayName: customerLooks.displayName,
  phoneE164: customerLooks.phoneE164,
  customerName: customers.fullName,
  productId: customerLooks.productId,
  productName: products.name,
  productSlug: products.slug,
  photoPath: customerLooks.photoPath,
  cardPath: customerLooks.cardPath,
  consentAnswer: customerLooks.consentAnswer,
  consentAt: customerLooks.consentAt,
  approvedAt: customerLooks.approvedAt,
  rejectedAt: customerLooks.rejectedAt,
  revokedAt: customerLooks.revokedAt,
  revokedBy: customerLooks.revokedBy,
  orderId: customerLooks.orderId,
  createdAt: customerLooks.createdAt,
};

/** Painel: com o "sim" dela e ainda sem decisão da dona. */
export async function listPendingLooks(db: DbOrTx): Promise<CustomerLookRow[]> {
  const rows = await db
    .select(lookRowSelect)
    .from(customerLooks)
    .innerJoin(products, eq(products.id, customerLooks.productId))
    .leftJoin(customers, eq(customers.id, customerLooks.customerId))
    .where(and(eq(customerLooks.consentAnswer, "sim"), isNull(customerLooks.approvedAt), isNull(customerLooks.rejectedAt), isNull(customerLooks.revokedAt), isNotNull(customerLooks.photoPath)))
    .orderBy(customerLooks.consentAt);
  return rows.map(toRow);
}

export async function countPendingLooks(db: DbOrTx): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(customerLooks)
    .where(and(eq(customerLooks.consentAnswer, "sim"), isNull(customerLooks.approvedAt), isNull(customerLooks.rejectedAt), isNull(customerLooks.revokedAt), isNotNull(customerLooks.photoPath)));
  return row?.total ?? 0;
}

/** Painel: as últimas fotos, em qualquer estado (para a dona ver o que a Lia registrou). */
export async function listRecentLooks(db: DbOrTx, input: { limit?: number } = {}): Promise<CustomerLookRow[]> {
  const rows = await db
    .select(lookRowSelect)
    .from(customerLooks)
    .innerJoin(products, eq(products.id, customerLooks.productId))
    .leftJoin(customers, eq(customers.id, customerLooks.customerId))
    .orderBy(desc(customerLooks.createdAt))
    .limit(input.limit ?? 200);
  return rows.map(toRow);
}

/** Painel: TODAS as que estão na vitrine agora — é daqui que a dona retira. */
export async function listPublicLooks(db: DbOrTx): Promise<CustomerLookRow[]> {
  const rows = await db
    .select(lookRowSelect)
    .from(customerLooks)
    .innerJoin(products, eq(products.id, customerLooks.productId))
    .leftJoin(customers, eq(customers.id, customerLooks.customerId))
    .where(and(eq(customerLooks.consentAnswer, "sim"), isNotNull(customerLooks.approvedAt), isNull(customerLooks.rejectedAt), isNull(customerLooks.revokedAt), isNotNull(customerLooks.photoPath)))
    .orderBy(desc(customerLooks.approvedAt));
  return rows.map(toRow);
}

export interface PublicLook {
  id: string;
  displayName: string;
  photoPath: string;
  approvedAt: Date;
}

/** Vitrine: só "sim" + aprovada + não retirada, as mais recentes. */
export async function listPublicLooksForProduct(db: DbOrTx, productId: string, limit = PUBLIC_LOOKS_PER_PRODUCT): Promise<PublicLook[]> {
  const rows = await db
    .select({ id: customerLooks.id, displayName: customerLooks.displayName, photoPath: customerLooks.photoPath, approvedAt: customerLooks.approvedAt })
    .from(customerLooks)
    .where(and(eq(customerLooks.productId, productId), eq(customerLooks.consentAnswer, "sim"), isNotNull(customerLooks.approvedAt), isNull(customerLooks.rejectedAt), isNull(customerLooks.revokedAt), isNotNull(customerLooks.photoPath)))
    .orderBy(desc(customerLooks.approvedAt))
    .limit(limit);
  return rows.flatMap((row) => (row.photoPath && row.approvedAt ? [{ id: row.id, displayName: row.displayName, photoPath: row.photoPath, approvedAt: row.approvedAt }] : []));
}

export async function countPublicLooksForProduct(db: DbOrTx, productId: string): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(customerLooks)
    .where(and(eq(customerLooks.productId, productId), eq(customerLooks.consentAnswer, "sim"), isNotNull(customerLooks.approvedAt), isNull(customerLooks.rejectedAt), isNull(customerLooks.revokedAt), isNotNull(customerLooks.photoPath)));
  return row?.total ?? 0;
}

/** Caderninho: "Foto dela com o Longo Dunas: na página (aprovada)" / "aguardando a resposta". */
export async function listLooksMemoryLines(db: DbOrTx, phoneE164: string, limit = 3): Promise<string[]> {
  const rows = await db
    .select({ productName: products.name, consentAnswer: customerLooks.consentAnswer, approvedAt: customerLooks.approvedAt, rejectedAt: customerLooks.rejectedAt, revokedAt: customerLooks.revokedAt })
    .from(customerLooks)
    .innerJoin(products, eq(products.id, customerLooks.productId))
    .where(eq(customerLooks.phoneE164, phoneE164))
    .orderBy(desc(customerLooks.createdAt))
    .limit(limit);
  return rows.map((row) => {
    const state = row.revokedAt
      ? "retirada"
      : isLookPublic(row)
        ? "na página da peça"
        : row.consentAnswer === "sim"
          ? "ela autorizou; aguardando a equipe"
          : row.consentAnswer === "nao"
            ? "ela preferiu não mostrar"
            : "aguardando a resposta dela";
    return `Foto dela com o ${row.productName}: ${state}.`;
  });
}
