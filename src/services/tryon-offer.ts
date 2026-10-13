// "Me vê com ela" — a oferta da Lia e o toque da cliente. A Lia oferece
// (pedido "offered" + a pergunta tocável); o toque em "Quero me ver" é o
// consentimento DESTA prévia; com a foto (a da pergunta, a que ela mandou
// logo antes do toque, ou a próxima), o pedido vai para a fila
// (services/tryon.queueTryOn). Cada foto tem o seu toque: foto que não
// serviu = outra pergunta. "Agora não" e SAIR valem a qualquer momento
// antes de a foto ir à FASHN. Aqui também: a linha do caderninho e o funil.
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, max, ne, or, sql } from "drizzle-orm";

import { parsePieceType } from "@/core/catalog/piece-types";
import {
  shouldOfferTryOn,
  TRYON_DECLINED_IN_FLIGHT_TEXT,
  TRYON_OFFER_TIMING,
  tryOnAnswerAckText,
  type TryOnAnswer,
  type TryOnOfferVerdict,
} from "@/core/tryon/offer";
import { blocksTryOnToday, failureText, photoRetryWelcome, quotaText, requiredFraming, TRYON_TIMING, tryOnCategoryFor, tryOnQuotaVerdict } from "@/core/tryon/rules";
import { assertTryOnTransition, isTryOnStatus, TRYON_IN_FLIGHT_STATUSES, type TryOnStatus } from "@/core/tryon/status";
import { auditLog, customers, orders, products, tryonRequests, waMessages } from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { garmentImageFor } from "@/services/studio";
import { countTryOnsToday, enqueueTryOnNotice, queueTryOn, TRYON_CONSENT_VERSION, type TryOnRequest } from "@/services/tryon";
import { loadTryOnSettings } from "@/services/tryon-settings";
import { isBotMediaEnabled } from "@/services/wa-media";

export type TryOnOfferEvaluation = {
  verdict: TryOnOfferVerdict;
  category: ReturnType<typeof tryOnCategoryFor>;
};

/**
 * Pode oferecer a prévia desta peça (nesta cor) nesta conversa agora? O
 * interruptor, a Lia enxergando fotos, a peça (roupa com foto real da cor e
 * estoque), os tetos, a última oferta e o último "Agora não".
 */
export async function evaluateTryOnOffer(
  db: DbOrTx,
  input: { conversationId: string; phoneE164: string; productId: string; color: string | null; inStock: boolean; colorInStock: boolean; asked?: boolean; now: Date },
): Promise<TryOnOfferEvaluation> {
  const settings = await loadTryOnSettings(db);
  if (!settings.enabled) return { verdict: { offer: false, reason: "desligado" }, category: null };
  const [product] = await db.select({ pieceType: products.pieceType }).from(products).where(eq(products.id, input.productId)).limit(1);
  const category = tryOnCategoryFor(parsePieceType(product?.pieceType ?? ""));
  const [mediaEnabled, garment, [inFlight], [lastOffer], [lastDecline], today, closedToday] = await Promise.all([
    isBotMediaEnabled(db),
    category ? garmentImageFor(db, input.productId, input.color) : Promise.resolve(null),
    db
      .select({ id: tryonRequests.id })
      .from(tryonRequests)
      .where(
        and(
          eq(tryonRequests.conversationId, input.conversationId),
          inArray(tryonRequests.status, [...TRYON_IN_FLIGHT_STATUSES]),
          // Parado há mais de 15 min = a fila perdeu a linha: não segura a oferta (queueTryOn cura ao enfileirar).
          gte(tryonRequests.updatedAt, new Date(input.now.getTime() - TRYON_TIMING.staleAfterMs)),
        ),
      )
      .limit(1),
    db.select({ at: max(tryonRequests.offeredAt) }).from(tryonRequests).where(eq(tryonRequests.conversationId, input.conversationId)),
    db
      .select({ at: max(tryonRequests.declinedAt) })
      .from(tryonRequests)
      .where(and(eq(tryonRequests.phoneE164, input.phoneE164), isNotNull(tryonRequests.declinedAt))),
    countTryOnsToday(db, { phoneE164: input.phoneE164, now: input.now }),
    db
      .select({ status: tryonRequests.status, failureReason: tryonRequests.failureReason })
      .from(tryonRequests)
      .where(
        and(
          eq(tryonRequests.conversationId, input.conversationId),
          inArray(tryonRequests.status, ["photo_rejected", "failed"]),
          gte(tryonRequests.createdAt, new Date(input.now.getTime() - TRYON_OFFER_TIMING.answerWindowMs)),
        ),
      ),
  ]);
  const quota = tryOnQuotaVerdict({
    customerToday: today.customer,
    totalToday: today.total,
    perCustomerDaily: settings.perCustomerDaily,
    dailyTotal: settings.dailyTotal,
  });
  const verdict = shouldOfferTryOn({
    enabled: settings.enabled,
    mediaEnabled,
    wearable: category !== null,
    hasGarmentPhoto: garment !== null,
    inStock: input.inStock,
    colorInStock: input.colorInStock,
    inFlight: inFlight !== undefined,
    quotaOk: quota.ok,
    blockedToday: closedToday.some((row) => blocksTryOnToday(row)),
    lastOfferAt: lastOffer?.at ?? null,
    lastDeclinedAt: lastDecline?.at ?? null,
    ...(input.asked ? { asked: true } : {}),
    now: input.now,
  });
  return { verdict, category };
}

/**
 * A linha que detalhar_produto acrescenta quando a Lia PODE oferecer a prévia
 * desta peça agora (o código decide; o modelo escolhe o momento). O ensaio de
 * 13/10 mostrou a Lia escrevendo a oferta com as próprias palavras — sem a
 * pergunta tocável não há consentimento: a linha diz COMO oferecer.
 */
export async function tryOnHintLine(
  db: DbOrTx,
  input: { conversationId: string; phoneE164: string; productId: string; inStock: boolean; now: Date },
): Promise<string | null> {
  const { verdict } = await evaluateTryOnOffer(db, { ...input, color: null, colorInStock: true });
  if (!verdict.offer) return null;
  return "PRÉVIA NA FOTO DELA: ela pode se ver vestindo esta peça na foto dela. Se ela escolheu a peça ou perguntou como fica nela, chame oferecer_previa AGORA — a pergunta tocável é que pede o consentimento; nunca escreva a oferta com as suas palavras.";
}

/** A oferta nasce como linha "offered" (o funil conta daqui); a lista tocável sai no turno. */
export async function createTryOnOffer(
  db: DbOrTx,
  input: { conversationId: string; customerId: string | null; phoneE164: string; productId: string; color: string | null; photoWaMessageId: string | null; now: Date },
): Promise<string> {
  const [row] = await db
    .insert(tryonRequests)
    .values({
      conversationId: input.conversationId,
      customerId: input.customerId,
      phoneE164: input.phoneE164,
      productId: input.productId,
      color: input.color,
      photoWaMessageId: input.photoWaMessageId,
      status: "offered",
      offeredAt: input.now,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning({ id: tryonRequests.id });
  return row!.id;
}

export type TryOnAnswerResult = { productName: string; answer: TryOnAnswer; ackEventId: string | null; jobEventId: string | null };

/** Muda o estado pela máquina (regra 3), só se a linha ainda estiver em `from`. */
async function move(tx: DbOrTx, request: TryOnRequest, to: TryOnStatus, patch: Partial<typeof tryonRequests.$inferInsert>, now: Date): Promise<TryOnRequest | null> {
  const from = request.status as TryOnStatus;
  assertTryOnTransition(from, to);
  const [updated] = await tx
    .update(tryonRequests)
    .set({ ...patch, status: to, updatedAt: now })
    .where(and(eq(tryonRequests.id, request.id), eq(tryonRequests.status, from)))
    .returning();
  return updated ?? null;
}

/**
 * "Agora não" (o toque ou o SAIR): para o que ainda não foi à FASHN e
 * carimba a recusa em tudo o que poderia ser reaberto — nada desta oferta
 * volta sozinho. O que já está com a FASHN termina (foi pago).
 */
async function declineRequest(tx: DbOrTx, request: TryOnRequest, now: Date): Promise<"declined" | "cancelled" | "in_flight" | "stamped" | "already" | "nothing"> {
  // Já recusada (depois do último aceite): o toque repetido não muda nada.
  const alreadyDeclined = request.status === "declined" || (request.declinedAt !== null && (!request.acceptedAt || request.declinedAt >= request.acceptedAt));
  if (alreadyDeclined) return "already";
  switch (request.status) {
    case "offered":
    case "awaiting_photo":
      return (await move(tx, request, "declined", { declinedAt: now }, now)) ? "declined" : "nothing";
    case "queued":
      // Ainda não foi à FASHN: cancela (a fila encontra "falhou" e não pede nada).
      return (await move(tx, request, "failed", { declinedAt: now, failureReason: "cliente_desistiu", finishedAt: now }, now)) ? "cancelled" : "nothing";
    case "submitting":
    case "processing":
    case "photo_rejected":
    case "failed":
      // Carimbo sem mudar o estado: impede reabrir com outra foto.
      await tx.update(tryonRequests).set({ declinedAt: now, updatedAt: now }).where(eq(tryonRequests.id, request.id));
      return request.status === "submitting" || request.status === "processing" ? "in_flight" : "stamped";
    default:
      return "nothing";
  }
}

/** Quanto antes do toque a foto pode ter chegado para valer como "a foto para a prévia". */
const PHOTO_BEFORE_TAP_MAX_MS = 10 * 60_000;

/**
 * A foto que ela mandou LOGO antes do toque (o texto da oferta pede o toque
 * primeiro, mas há quem mande a foto antes): só se for a última mensagem
 * dela, depois da pergunta e há poucos minutos. Um print, uma foto de
 * amiga ou um comprovante de horas atrás nunca vira "a foto é minha".
 */
async function photoRightBeforeTap(tx: DbOrTx, request: TryOnRequest, input: { tapMessageId: string; now: Date }): Promise<string | null> {
  const [last] = await tx
    .select({ id: waMessages.id, kind: waMessages.kind, createdAt: waMessages.createdAt })
    .from(waMessages)
    .where(and(eq(waMessages.conversationId, request.conversationId), eq(waMessages.direction, "inbound"), ne(waMessages.id, input.tapMessageId)))
    .orderBy(desc(waMessages.createdAt))
    .limit(1);
  if (!last || last.kind !== "image") return null;
  if (last.createdAt <= request.offeredAt || input.now.getTime() - last.createdAt.getTime() > PHOTO_BEFORE_TAP_MAX_MS) return null;
  return last.id;
}

/**
 * O toque na pergunta (webhook). Só vale da conversa que recebeu a pergunta
 * e dentro de 24 h; null = não é com esta oferta (o toque vira texto para a
 * Lia, que decide). "Quero me ver" grava o consentimento DESTA prévia; com a
 * foto (a da pergunta ou uma que ela mandou depois dela), vai direto para a
 * fila. "Agora não" vale a qualquer momento. Cada toque tem a sua resposta
 * (dedupe pela mensagem do toque).
 */
export async function recordTryOnAnswer(
  tx: DbOrTx,
  input: { requestId: string; answer: TryOnAnswer; conversationId: string; tapMessageId: string; now: Date },
): Promise<TryOnAnswerResult | null> {
  const [found] = await tx
    .select({ request: tryonRequests, productName: products.name, pieceType: products.pieceType })
    .from(tryonRequests)
    .innerJoin(products, eq(products.id, tryonRequests.productId))
    .where(eq(tryonRequests.id, input.requestId))
    .limit(1);
  if (!found || found.request.conversationId !== input.conversationId) return null;
  const request = found.request;
  if (!isTryOnStatus(request.status)) return null;
  if (input.now.getTime() - request.offeredAt.getTime() > TRYON_OFFER_TIMING.answerWindowMs) return null;
  const base = { productName: found.productName, answer: input.answer };
  const ackKey = `resposta:${input.tapMessageId}`;

  if (input.answer === "agora_nao") {
    let outcome = await declineRequest(tx, request, input.now);
    if (outcome === "nothing") {
      // A fila mudou o estado no meio do caminho (ex.: foi para a FASHN): relê e tenta uma vez mais.
      const [fresh] = await tx.select().from(tryonRequests).where(eq(tryonRequests.id, request.id)).limit(1);
      if (fresh) outcome = await declineRequest(tx, fresh, input.now);
    }
    // Toque repetido: nada muda, nenhuma resposta nova.
    if (outcome === "already") return { ...base, ackEventId: null, jobEventId: null };
    if (outcome === "nothing") return null;
    await tx.insert(auditLog).values({ actorType: "customer", action: "tryon.decline", entityType: "tryon_request", entityId: request.id, after: { from: request.status, outcome } });
    const body =
      outcome === "in_flight"
        ? TRYON_DECLINED_IN_FLIGHT_TEXT
        : outcome === "cancelled"
          ? failureText("cliente_desistiu")
          : tryOnAnswerAckText({ answer: "agora_nao", withPhoto: false, framing: null });
    const ackEventId = await enqueueTryOnNotice(tx, request, ackKey, body);
    return { ...base, ackEventId, jobEventId: null };
  }

  // "Quero me ver": só da oferta (ou de um "Agora não" que ela reconsiderou). Depois disso, vira texto para a Lia.
  if (request.status !== "offered" && request.status !== "declined") return null;
  const settings = await loadTryOnSettings(tx);
  if (!settings.enabled) {
    // Desligada depois da oferta: nada de consentimento para uma prévia que não vai sair.
    const ackEventId = await enqueueTryOnNotice(tx, request, ackKey, failureText("desligado"));
    return { ...base, ackEventId, jobEventId: null };
  }
  const accepted = await move(tx, request, "awaiting_photo", { acceptedAt: input.now, consentVersion: TRYON_CONSENT_VERSION, declinedAt: null }, input.now);
  if (!accepted) return null;
  await tx.insert(auditLog).values({
    actorType: "customer",
    action: "tryon.consent",
    entityType: "tryon_request",
    entityId: request.id,
    after: { productId: request.productId, consentVersion: TRYON_CONSENT_VERSION },
  });

  const category = tryOnCategoryFor(parsePieceType(found.pieceType ?? ""));
  const photoId = accepted.photoWaMessageId ?? (await photoRightBeforeTap(tx, accepted, input));
  if (!photoId) {
    const ackEventId = await enqueueTryOnNotice(
      tx,
      accepted,
      ackKey,
      tryOnAnswerAckText({ answer: "quero", withPhoto: false, framing: category ? requiredFraming(category) : null }),
    );
    return { ...base, ackEventId, jobEventId: null };
  }

  const queued = await queueTryOn(tx, { requestId: accepted.id, photoWaMessageId: photoId, now: input.now, kick: false });
  if (queued.ok) {
    const ackEventId = await enqueueTryOnNotice(tx, accepted, ackKey, tryOnAnswerAckText({ answer: "quero", withPhoto: true, framing: null }));
    return { ...base, ackEventId, jobEventId: queued.eventId };
  }
  const body =
    queued.reason === "limite_cliente" || queued.reason === "limite_loja" || queued.reason === "limite_fotos"
      ? quotaText(queued.reason, settings.perCustomerDaily)
      : queued.reason === "em_andamento"
        ? "Já tem uma prévia sua sendo feita — chega já já 🪄"
        : failureText("indisponivel");
  const ackEventId = await enqueueTryOnNotice(tx, accepted, ackKey, body);
  return { ...base, ackEventId, jobEventId: null };
}

export type TryOnForPhoto =
  | { kind: "ready"; request: TryOnRequest; productName: string }
  | { kind: "pending_tap"; productName: string }
  | { kind: "in_flight"; productName: string }
  | { kind: "ask_again"; productName: string }
  | { kind: "none" };

/** O toque vale por 2 h para a foto — e um "Agora não" depois dele o revoga. */
function consentAlive(request: TryOnRequest, now: Date): boolean {
  if (!request.acceptedAt || now.getTime() - request.acceptedAt.getTime() > TRYON_OFFER_TIMING.photoWindowMs) return false;
  return !request.declinedAt || request.declinedAt < request.acceptedAt;
}

/**
 * Para vestir_em_mim: em que pé está a prévia mais recente desta conversa.
 * "ready" = aceita, esperando a foto; "pending_tap" = a pergunta foi, o
 * toque não; "ask_again" = a foto anterior não serviu por um problema DA
 * FOTO — outra foto pede outra pergunta (cada foto tem o seu toque).
 */
export async function findTryOnForPhoto(db: DbOrTx, input: { conversationId: string; now: Date }): Promise<TryOnForPhoto> {
  const since = new Date(input.now.getTime() - TRYON_OFFER_TIMING.answerWindowMs);
  const [latest] = await db
    .select({ request: tryonRequests, productName: products.name })
    .from(tryonRequests)
    .innerJoin(products, eq(products.id, tryonRequests.productId))
    .where(and(eq(tryonRequests.conversationId, input.conversationId), gte(tryonRequests.offeredAt, since)))
    .orderBy(desc(tryonRequests.createdAt))
    .limit(1);
  if (!latest) return { kind: "none" };
  const { request, productName } = latest;
  if ((TRYON_IN_FLIGHT_STATUSES as readonly string[]).includes(request.status)) return { kind: "in_flight", productName };
  if (request.status === "offered") return { kind: "pending_tap", productName };
  if (request.status === "awaiting_photo") return consentAlive(request, input.now) ? { kind: "ready", request, productName } : { kind: "none" };
  const declinedAfter = request.declinedAt !== null && (!request.acceptedAt || request.declinedAt >= request.acceptedAt);
  if (photoRetryWelcome(request) && !declinedAfter) return { kind: "ask_again", productName };
  return { kind: "none" };
}

function hhmm(date: Date): string {
  return date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
}

/** A linha do caderninho: em que pé está a prévia desta conversa (a mais recente, nas últimas 24 h). Desligada: nada. */
export async function tryOnMemoryLines(db: DbOrTx, input: { conversationId: string; now: Date }): Promise<string[]> {
  if (!(await loadTryOnSettings(db)).enabled) return [];
  const since = new Date(input.now.getTime() - TRYON_OFFER_TIMING.answerWindowMs);
  const [latest] = await db
    .select({ request: tryonRequests, productName: products.name })
    .from(tryonRequests)
    .innerJoin(products, eq(products.id, tryonRequests.productId))
    .where(and(eq(tryonRequests.conversationId, input.conversationId), gte(tryonRequests.createdAt, since)))
    .orderBy(desc(tryonRequests.createdAt))
    .limit(1);
  if (!latest) return [];
  const { request, productName } = latest;
  const peca = `${productName}${request.color ? ` (${request.color})` : ""}`;
  switch (request.status) {
    case "offered":
      return [`Prévia na foto oferecida às ${hhmm(request.offeredAt)} (${peca}): esperando o toque dela em "Quero me ver" — não ofereça de novo; se ela mandar foto antes, lembre de tocar.`];
    case "declined":
      return [`Ela respondeu "Agora não" à prévia (${peca}): não ofereça de novo; ela pode pedir.`];
    case "awaiting_photo":
      return consentAlive(request, input.now)
        ? [`Ela tocou "Quero me ver" (${peca}): quando a foto DELA chegar, chame vestir_em_mim — não pergunte de novo.`]
        : [`O toque dela em "Quero me ver" (${peca}) expirou (mais de 2 h): se ela mandar foto, chame oferecer_previa com ela_pediu e com_a_foto_dela.`];
    case "queued":
    case "submitting":
    case "processing":
      return [`Prévia de ${peca} sendo feita: chega sozinha em 1–2 min. Não prometa caimento nem tamanho.`];
    case "sent":
      return [`Prévia de ${peca} enviada às ${hhmm(request.sentAt ?? request.updatedAt)}: pergunte o que ela achou e siga para cor e tamanho (sugerir_tamanho), reservar ou fechar.`];
    case "photo_rejected":
    case "failed":
      if (blocksTryOnToday(request)) return [`A prévia de ${peca} não pôde ser feita com a foto dela: hoje não ofereça a prévia de novo nem comente; siga mostrando a peça na modelo.`];
      if (request.failureReason === "cliente_desistiu") return [`Ela desistiu da prévia (${peca}): não ofereça de novo; ela pode pedir.`];
      if (photoRetryWelcome(request)) {
        return [`A foto não serviu para a prévia de ${peca} (ela já recebeu a dica): se ela mandar outra foto DELA, chame oferecer_previa com com_a_foto_dela e ela_pediu — cada foto tem o seu toque.`];
      }
      return [`A prévia de ${peca} não saiu (ela já foi avisada): não ofereça de novo hoje; siga mostrando a peça na modelo e conferindo o tamanho.`];
    default:
      return [];
  }
}

/**
 * SAIR: nada desta conversa segue sozinho — oferta e aceite sem foto viram
 * "Agora não", o que está na fila (ainda não foi à FASHN) é cancelado e o
 * resto fica carimbado (o que está com a FASHN termina, mas sem segunda
 * tentativa paga).
 */
export async function declinePendingTryOns(tx: DbOrTx, input: { conversationId: string; now: Date }): Promise<number> {
  const since = new Date(input.now.getTime() - TRYON_OFFER_TIMING.answerWindowMs);
  const rows = await tx
    .select()
    .from(tryonRequests)
    .where(
      and(
        eq(tryonRequests.conversationId, input.conversationId),
        isNull(tryonRequests.declinedAt),
        or(
          inArray(tryonRequests.status, ["offered", "awaiting_photo", "queued", "submitting", "processing"]),
          and(inArray(tryonRequests.status, ["photo_rejected", "failed"]), gte(tryonRequests.offeredAt, since)),
        ),
      ),
    );
  let changed = 0;
  for (const request of rows) {
    const outcome = await declineRequest(tx, request, input.now);
    if (outcome !== "nothing" && outcome !== "already") changed += 1;
  }
  return changed;
}

export type TryOnFunnel = { offered: number; accepted: number; sent: number; bought: number; usdCents: number };

/**
 * O funil do painel no período: ofertas → "Quero me ver" → prévias enviadas
 * → prévias seguidas de compra em até 7 dias (pedido pago da mesma cliente,
 * pelo cadastro ou pelo telefone) → gasto (FASHN + portões, centavos de dólar).
 */
export async function tryOnFunnel(db: DbOrTx, input: { from: Date; to: Date }): Promise<TryOnFunnel> {
  const [row] = await db
    .select({
      offered: sql<number>`count(*) filter (where ${tryonRequests.offeredAt} >= ${input.from} and ${tryonRequests.offeredAt} < ${input.to})::int`,
      accepted: sql<number>`count(*) filter (where ${tryonRequests.acceptedAt} >= ${input.from} and ${tryonRequests.acceptedAt} < ${input.to})::int`,
      sent: sql<number>`count(*) filter (where ${tryonRequests.sentAt} >= ${input.from} and ${tryonRequests.sentAt} < ${input.to})::int`,
      usdCents: sql<number>`coalesce(sum(${tryonRequests.usdCents}) filter (where ${tryonRequests.createdAt} >= ${input.from} and ${tryonRequests.createdAt} < ${input.to}), 0)::int`,
    })
    .from(tryonRequests);
  const [bought] = await db
    .select({ count: sql<number>`count(distinct ${tryonRequests.id})::int` })
    .from(tryonRequests)
    .innerJoin(customers, or(eq(customers.id, tryonRequests.customerId), eq(customers.phoneE164, tryonRequests.phoneE164)))
    .innerJoin(orders, eq(orders.customerId, customers.id))
    .where(
      and(
        gte(tryonRequests.sentAt, input.from),
        lt(tryonRequests.sentAt, input.to),
        isNotNull(orders.paidAt),
        sql`${orders.paidAt} >= ${tryonRequests.sentAt} and ${orders.paidAt} < ${tryonRequests.sentAt} + interval '7 days'`,
      ),
    );
  return {
    offered: row?.offered ?? 0,
    accepted: row?.accepted ?? 0,
    sent: row?.sent ?? 0,
    bought: bought?.count ?? 0,
    usdCents: row?.usdCents ?? 0,
  };
}
