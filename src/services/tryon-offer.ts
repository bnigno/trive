// "Me vê com ela" — a oferta da Lia e o toque da cliente. A Lia oferece
// (pedido "offered" + a pergunta tocável); o toque em "Quero me ver" é o
// consentimento DESTA prévia; com a foto (já na conversa ou a próxima que
// ela mandar), o pedido vai para a fila (services/tryon.queueTryOn). Aqui
// também: a linha do caderninho, o "SAIR" e o funil do painel.
import { and, desc, eq, gte, inArray, isNotNull, lt, max, sql } from "drizzle-orm";

import { parsePieceType } from "@/core/catalog/piece-types";
import {
  shouldOfferTryOn,
  TRYON_OFFER_TIMING,
  tryOnAnswerAckText,
  type TryOnAnswer,
  type TryOnOfferVerdict,
} from "@/core/tryon/offer";
import { failureText, quotaText, requiredFraming, TRYON_TIMING, tryOnCategoryFor, tryOnQuotaVerdict } from "@/core/tryon/rules";
import { assertTryOnTransition, isTryOnStatus, TRYON_IN_FLIGHT_STATUSES } from "@/core/tryon/status";
import { auditLog, customers, orders, products, tryonRequests } from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { countTryOnsToday, enqueueTryOnNotice, queueTryOn, TRYON_CONSENT_VERSION, type TryOnRequest } from "@/services/tryon";
import { loadTryOnSettings } from "@/services/tryon-settings";

export type TryOnOfferEvaluation = {
  verdict: TryOnOfferVerdict;
  category: ReturnType<typeof tryOnCategoryFor>;
};

/** Pode oferecer a prévia desta peça nesta conversa agora? (o interruptor, a peça, os tetos, a última oferta e o último "Agora não") */
export async function evaluateTryOnOffer(
  db: DbOrTx,
  input: { conversationId: string; phoneE164: string; productId: string; inStock: boolean; asked?: boolean; now: Date },
): Promise<TryOnOfferEvaluation> {
  const settings = await loadTryOnSettings(db);
  if (!settings.enabled) return { verdict: { offer: false, reason: "desligado" }, category: null };
  const [product] = await db.select({ pieceType: products.pieceType }).from(products).where(eq(products.id, input.productId)).limit(1);
  const category = tryOnCategoryFor(parsePieceType(product?.pieceType ?? ""));
  const [[inFlight], [lastOffer], [lastDecline], today] = await Promise.all([
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
  ]);
  const quota = tryOnQuotaVerdict({
    customerToday: today.customer,
    totalToday: today.total,
    perCustomerDaily: settings.perCustomerDaily,
    dailyTotal: settings.dailyTotal,
  });
  const verdict = shouldOfferTryOn({
    enabled: settings.enabled,
    wearable: category !== null,
    inStock: input.inStock,
    inFlight: inFlight !== undefined,
    quotaOk: quota.ok,
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
  const { verdict } = await evaluateTryOnOffer(db, input);
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

/** Resposta curta ao toque: fala da Lia (dedupe `wa.bot_tryon:`), pela fila. */
const enqueueAck = enqueueTryOnNotice;

/**
 * O toque na pergunta (webhook). Só vale da conversa que recebeu a pergunta
 * e dentro de 24 h; null = não é com esta oferta (o toque vira texto para a
 * Lia, que oferece de novo se fizer sentido). "Quero me ver" grava o
 * consentimento DESTA prévia; com a foto já na conversa, vai direto para a
 * fila. Toque repetido não repete nada.
 */
export async function recordTryOnAnswer(
  tx: DbOrTx,
  input: { requestId: string; answer: TryOnAnswer; conversationId: string; now: Date },
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

  if (input.answer === "agora_nao") {
    if (request.status !== "offered" && request.status !== "awaiting_photo") return { ...base, ackEventId: null, jobEventId: null };
    assertTryOnTransition(request.status, "declined");
    const [declined] = await tx
      .update(tryonRequests)
      .set({ status: "declined", declinedAt: input.now, updatedAt: input.now })
      .where(and(eq(tryonRequests.id, request.id), eq(tryonRequests.status, request.status)))
      .returning();
    if (!declined) return { ...base, ackEventId: null, jobEventId: null };
    await tx.insert(auditLog).values({ actorType: "customer", action: "tryon.decline", entityType: "tryon_request", entityId: request.id, after: { productId: request.productId } });
    const ackEventId = await enqueueAck(tx, request, "resposta:agora_nao", tryOnAnswerAckText({ answer: "agora_nao", withPhoto: false, framing: null }));
    return { ...base, ackEventId, jobEventId: null };
  }

  // "Quero me ver": vale da oferta ou de um "Agora não" que ela reconsiderou; repetido não faz nada.
  if (request.status !== "offered" && request.status !== "declined") return { ...base, ackEventId: null, jobEventId: null };
  assertTryOnTransition(request.status, "awaiting_photo");
  const [accepted] = await tx
    .update(tryonRequests)
    .set({ status: "awaiting_photo", acceptedAt: input.now, consentVersion: TRYON_CONSENT_VERSION, declinedAt: null, updatedAt: input.now })
    .where(and(eq(tryonRequests.id, request.id), eq(tryonRequests.status, request.status)))
    .returning();
  if (!accepted) return { ...base, ackEventId: null, jobEventId: null };
  await tx.insert(auditLog).values({
    actorType: "customer",
    action: "tryon.consent",
    entityType: "tryon_request",
    entityId: request.id,
    after: { productId: request.productId, consentVersion: TRYON_CONSENT_VERSION },
  });

  const category = tryOnCategoryFor(parsePieceType(found.pieceType ?? ""));
  if (!accepted.photoWaMessageId) {
    const ackEventId = await enqueueAck(
      tx,
      accepted,
      "resposta:quero",
      tryOnAnswerAckText({ answer: "quero", withPhoto: false, framing: category ? requiredFraming(category) : null }),
    );
    return { ...base, ackEventId, jobEventId: null };
  }

  // A foto já estava na conversa (a oferta foi sobre ELA): direto para a fila.
  const queued = await queueTryOn(tx, { requestId: accepted.id, photoWaMessageId: accepted.photoWaMessageId, now: input.now, kick: false });
  if (queued.ok) {
    const ackEventId = await enqueueAck(tx, accepted, "resposta:quero", tryOnAnswerAckText({ answer: "quero", withPhoto: true, framing: null }));
    return { ...base, ackEventId, jobEventId: queued.eventId };
  }
  const settings = await loadTryOnSettings(tx);
  const body =
    queued.reason === "limite_cliente" || queued.reason === "limite_loja" || queued.reason === "limite_fotos"
      ? quotaText(queued.reason, settings.perCustomerDaily)
      : queued.reason === "em_andamento"
        ? "Já tem uma prévia sua sendo feita — chega já já 🪄"
        : failureText("indisponivel");
  const ackEventId = await enqueueAck(tx, accepted, `resposta:quero:${queued.reason}`, body);
  return { ...base, ackEventId, jobEventId: null };
}

export type TryOnForPhoto =
  | { kind: "ready"; request: TryOnRequest; productName: string }
  | { kind: "none" }
  | { kind: "in_flight"; productName: string };

/**
 * Para vestir_em_mim: o pedido aceito que espera a foto (até 2 h depois do
 * toque). Foto anterior recusada (enquadramento, não abriu, recusada pela
 * IA) vale como "manda outra": um pedido novo nasce com o MESMO
 * consentimento — a mesma peça, a mesma vontade.
 */
export async function findTryOnForPhoto(db: DbOrTx, input: { conversationId: string; now: Date }): Promise<TryOnForPhoto> {
  const since = new Date(input.now.getTime() - TRYON_OFFER_TIMING.photoWindowMs);
  const [latest] = await db
    .select({ request: tryonRequests, productName: products.name })
    .from(tryonRequests)
    .innerJoin(products, eq(products.id, tryonRequests.productId))
    .where(and(eq(tryonRequests.conversationId, input.conversationId), isNotNull(tryonRequests.acceptedAt), gte(tryonRequests.acceptedAt, since)))
    .orderBy(desc(tryonRequests.createdAt))
    .limit(1);
  if (!latest) return { kind: "none" };
  const { request, productName } = latest;
  if ((TRYON_IN_FLIGHT_STATUSES as readonly string[]).includes(request.status)) return { kind: "in_flight", productName };
  if (request.status === "awaiting_photo") return { kind: "ready", request, productName };
  const retryable =
    request.status === "photo_rejected" || (request.status === "failed" && (request.failureReason === "foto_indisponivel" || request.failureReason === "recusada_pela_ia"));
  if (!retryable) return { kind: "none" };
  const [clone] = await db
    .insert(tryonRequests)
    .values({
      conversationId: request.conversationId,
      customerId: request.customerId,
      phoneE164: request.phoneE164,
      productId: request.productId,
      color: request.color,
      status: "awaiting_photo",
      offeredAt: request.offeredAt,
      acceptedAt: request.acceptedAt,
      consentVersion: request.consentVersion,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning();
  return { kind: "ready", request: clone!, productName };
}

function hhmm(date: Date): string {
  return date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
}

/** A linha do caderninho: em que pé está a prévia desta conversa (a mais recente, nas últimas 24 h). */
export async function tryOnMemoryLines(db: DbOrTx, input: { conversationId: string; now: Date }): Promise<string[]> {
  const since = new Date(input.now.getTime() - TRYON_OFFER_TIMING.reofferAfterMs);
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
      return [`Prévia na foto oferecida às ${hhmm(request.offeredAt)} (${peca}): esperando o toque dela — não ofereça de novo.`];
    case "declined":
      return [`Ela respondeu "Agora não" à prévia (${peca}): não ofereça de novo; ela pode pedir.`];
    case "awaiting_photo":
      return [`Ela tocou "Quero me ver" (${peca}): quando a foto DELA chegar, chame vestir_em_mim — não pergunte de novo.`];
    case "queued":
    case "submitting":
    case "processing":
      return [`Prévia de ${peca} sendo feita: chega sozinha em 1–2 min. Não prometa caimento nem tamanho.`];
    case "sent":
      return [`Prévia de ${peca} enviada às ${hhmm(request.sentAt ?? request.updatedAt)}: pergunte o que ela achou e siga para cor e tamanho (sugerir_tamanho), reservar ou fechar.`];
    case "photo_rejected":
      return [`A foto não serviu para a prévia de ${peca} (ela recebeu a dica): se ela mandar outra foto DELA, chame vestir_em_mim.`];
    case "failed":
      return request.failureReason === "foto_indisponivel" || request.failureReason === "recusada_pela_ia"
        ? [`A prévia de ${peca} não saiu com aquela foto (ela já foi avisada): se ela mandar outra foto DELA, chame vestir_em_mim.`]
        : [`A prévia de ${peca} não saiu (ela já foi avisada): siga mostrando a peça na modelo e conferindo o tamanho.`];
    default:
      return [];
  }
}

/** SAIR: oferta e pedido aceito sem foto param aqui (o que já está com a FASHN termina — já foi pago). */
export async function declinePendingTryOns(tx: DbOrTx, input: { conversationId: string; now: Date }): Promise<number> {
  const rows = await tx
    .update(tryonRequests)
    .set({ status: "declined", declinedAt: input.now, updatedAt: input.now })
    .where(and(eq(tryonRequests.conversationId, input.conversationId), inArray(tryonRequests.status, ["offered", "awaiting_photo"])))
    .returning({ id: tryonRequests.id });
  return rows.length;
}

export type TryOnFunnel = { offered: number; accepted: number; sent: number; bought: number; usdCents: number };

/**
 * O funil do painel no período: ofertas → "Quero me ver" → prévias enviadas
 * → compraram em até 7 dias depois da prévia (pedido pago do mesmo
 * telefone) → gasto (FASHN + portões, centavos de dólar).
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
    .innerJoin(customers, eq(customers.phoneE164, tryonRequests.phoneE164))
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
