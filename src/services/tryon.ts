// "Me vê com ela" — a parte leve: o evento da fila, quanto já foi feito hoje,
// o passo que põe um pedido aceito na fila, o aviso à cliente pela fila e a
// cura dos pedidos presos. O trabalho pesado (FASHN, portões, envio) fica em
// services/tryon-generate.ts, que só a fila importa.
import { and, eq, gt, gte, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";

import { creditsFor, creditsToUsdCents } from "@/core/studio/cost";
import { staleNoticeText, TRYON_PHOTO_REJECTIONS_PER_PREVIEW, TRYON_TIMING, tryOnQuotaVerdict } from "@/core/tryon/rules";
import { assertTryOnTransition, isTryOnStatus, TRYON_IN_FLIGHT_STATUSES, type TryOnStatus } from "@/core/tryon/status";
import { auditLog, products, tryonRequests, waMessages } from "@/db/schema";
import { spDayKey, spDayStart } from "@/lib/sp-day";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";
import { loadTryOnSettings } from "@/services/tryon-settings";

export const TRYON_EVENT = "wa.tryon";

export const tryOnPayloadSchema = z.object({ requestId: z.uuid() });

/** A versão do texto de consentimento que o toque em "Quero me ver" aceita. */
export const TRYON_CONSENT_VERSION = "previa-v1-2026-10";

export type TryOnRequest = typeof tryonRequests.$inferSelect;

/** Prefixo `wa.bot_`: a prévia e os avisos dela entram no histórico como falas da Lia (core/whatsapp/origin). */
export function tryOnMessageDedupeKey(requestId: string, what: string): string {
  return `wa.bot_tryon:${requestId}:${what}`;
}

/**
 * Aviso curto à cliente PELA FILA (wa.send, com a política padrão: Z-API
 * fora do ar acumula e sai na volta). Vai na mesma transação da mudança de
 * estado — o pedido nunca fica preso porque o WhatsApp caiu (regra 5).
 */
export async function enqueueTryOnNotice(tx: DbOrTx, request: Pick<TryOnRequest, "id" | "phoneE164" | "customerId">, what: string, body: string): Promise<string | null> {
  const dedupeKey = tryOnMessageDedupeKey(request.id, what);
  return enqueueOutboxEvent(
    tx,
    {
      eventType: "wa.send",
      dedupeKey,
      aggregateType: "tryon_request",
      aggregateId: request.id,
      // verifyPhone: false — é resposta a quem está na conversa (sem a consulta extra à Z-API, que pode sumir com o aviso).
      payload: { phoneE164: request.phoneE164, body, dedupeKey, verifyPhone: false, ...(request.customerId ? { customerId: request.customerId } : {}) },
    },
    { kick: false },
  );
}

/**
 * Quanto já foi feito hoje (dia de São Paulo), da cliente e da loja: conta o
 * que foi (ou pode ter sido) pedido à FASHN — inclusive o "envio incerto",
 * que pode ter sido cobrado — e o que está a caminho dela. Falha antes de
 * pedir (foto que não abriu, desligado) não gasta a cota de ninguém. À parte,
 * as fotos dela recusadas na checagem (cada uma passa pela visão; têm teto
 * próprio).
 */
export async function countTryOnsToday(db: DbOrTx, input: { phoneE164: string; now: Date }): Promise<{ customer: number; total: number; rejected: number }> {
  const since = spDayStart(spDayKey(input.now));
  const counted = or(
    gt(tryonRequests.attempts, 0),
    gt(tryonRequests.credits, 0),
    isNotNull(tryonRequests.submittedAt),
    inArray(tryonRequests.status, [...TRYON_IN_FLIGHT_STATUSES]),
  );
  const [row] = await db
    .select({
      total: sql<number>`count(*) filter (where ${counted})::int`,
      customer: sql<number>`count(*) filter (where ${counted} and ${tryonRequests.phoneE164} = ${input.phoneE164})::int`,
      rejected: sql<number>`count(*) filter (where ${tryonRequests.status} = 'photo_rejected' and ${tryonRequests.phoneE164} = ${input.phoneE164})::int`,
    })
    .from(tryonRequests)
    .where(gte(tryonRequests.queuedAt, since));
  return { customer: row?.customer ?? 0, total: row?.total ?? 0, rejected: row?.rejected ?? 0 };
}

/**
 * Pedido "em andamento" parado há mais de 15 min nesta conversa: a fila
 * perdeu a linha (função morta no meio, linha morta). Encerra e avisa a
 * cliente pela fila — senão o índice "uma por conversa" travaria a conversa
 * para sempre. O que a FASHN pode ter cobrado fica registrado pela tabela.
 */
export async function healStaleTryOns(db: DbOrTx, input: { conversationId: string; now: Date }): Promise<number> {
  const staleBefore = new Date(input.now.getTime() - TRYON_TIMING.staleAfterMs);
  const stale = await db
    .select({ request: tryonRequests, productName: products.name })
    .from(tryonRequests)
    .innerJoin(products, eq(products.id, tryonRequests.productId))
    .where(
      and(
        eq(tryonRequests.conversationId, input.conversationId),
        inArray(tryonRequests.status, [...TRYON_IN_FLIGHT_STATUSES]),
        lt(tryonRequests.updatedAt, staleBefore),
      ),
    );
  let healed = 0;
  for (const { request, productName } of stale) {
    const from = request.status as TryOnStatus;
    assertTryOnTransition(from, "failed");
    // Enviando/fazendo: a FASHN pode ter cobrado esta tentativa — o gasto registrado nunca desce.
    const maybeCharged = from === "processing" || (from === "submitting" && request.attempts > 0);
    const estimate = maybeCharged ? creditsFor("tryon", "alta", 1) : 0;
    const done = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(tryonRequests)
        .set({
          status: "failed",
          failureReason: "demorou_demais",
          credits: request.credits + estimate,
          usdCents: request.usdCents + creditsToUsdCents(estimate),
          finishedAt: input.now,
          updatedAt: input.now,
        })
        // A mesma condição do SELECT: tocada no meio do caminho, não está parada.
        .where(and(eq(tryonRequests.id, request.id), eq(tryonRequests.status, from), lt(tryonRequests.updatedAt, staleBefore)))
        .returning({ id: tryonRequests.id });
      if (!updated) return false;
      await tx.insert(auditLog).values({
        actorType: "system",
        action: "tryon.fail",
        entityType: "tryon_request",
        entityId: request.id,
        after: { from, reason: "demorou_demais", detail: "parado: a fila perdeu a linha", vendorJobId: request.vendorJobId, estimatedCredits: estimate },
      });
      await enqueueTryOnNotice(tx, request, "falhou:demorou_demais", staleNoticeText(productName));
      return true;
    });
    if (done) healed += 1;
  }
  return healed;
}

export type QueueTryOnResult =
  | { ok: true; eventId: string | null }
  | {
      ok: false;
      reason:
        | "nao_encontrado"
        | "sem_consentimento"
        | "estado_invalido"
        | "foto_invalida"
        | "foto_antiga"
        | "desligado"
        | "limite_cliente"
        | "limite_loja"
        | "limite_fotos"
        | "em_andamento";
    };

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown; cause?: { code?: unknown } } | null)?.code ?? (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return code === "23505";
}

/**
 * Pedido ACEITO (ela tocou "Quero me ver", e não voltou atrás) + a foto DELA
 * (uma imagem que ela mandou NESTA conversa) → na fila. Confere o
 * interruptor e os tetos do dia ANTES de gastar. Dentro do turno da Lia (a
 * transação dela), passe kick: false — quem chama dá o kick depois do commit
 * com o eventId devolvido.
 */
export async function queueTryOn(
  db: DbOrTx,
  input: { requestId: string; photoWaMessageId: string; now: Date; kick?: boolean },
): Promise<QueueTryOnResult> {
  const [request] = await db.select().from(tryonRequests).where(eq(tryonRequests.id, input.requestId)).limit(1);
  if (!request || !isTryOnStatus(request.status)) return { ok: false, reason: "nao_encontrado" };
  // O consentimento é o toque — e um "Agora não" depois dele o revoga.
  if (!request.acceptedAt || (request.declinedAt && request.declinedAt >= request.acceptedAt)) return { ok: false, reason: "sem_consentimento" };
  const from: TryOnStatus = request.status;
  if (from !== "offered" && from !== "awaiting_photo") return { ok: false, reason: "estado_invalido" };

  // A foto tem de ser uma imagem que ELA mandou nesta conversa: nunca a de outra pessoa ou de outra conversa.
  const [photo] = await db
    .select({ id: waMessages.id, createdAt: waMessages.createdAt })
    .from(waMessages)
    .where(
      and(
        eq(waMessages.id, input.photoWaMessageId),
        eq(waMessages.conversationId, request.conversationId),
        eq(waMessages.direction, "inbound"),
        eq(waMessages.kind, "image"),
      ),
    )
    .limit(1);
  if (!photo) return { ok: false, reason: "foto_invalida" };
  // E a foto de AGORA: o toque vale para a foto que ela mandar depois da pergunta (um print de antes não
  // é "a foto é minha") — a não ser a própria foto sobre a qual a pergunta foi feita, ainda não usada.
  // Reaberta (a foto anterior não serviu), só uma foto mais nova que a tentativa anterior.
  const isOfferedPhoto = photo.id === request.photoWaMessageId && request.queuedAt === null;
  const notBefore = Math.max(request.offeredAt.getTime(), request.queuedAt?.getTime() ?? 0);
  if (!isOfferedPhoto && photo.createdAt.getTime() <= notBefore) return { ok: false, reason: "foto_antiga" };

  const settings = await loadTryOnSettings(db);
  if (!settings.enabled) return { ok: false, reason: "desligado" };
  await healStaleTryOns(db, { conversationId: request.conversationId, now: input.now });
  const today = await countTryOnsToday(db, { phoneE164: request.phoneE164, now: input.now });
  if (today.rejected >= settings.perCustomerDaily * TRYON_PHOTO_REJECTIONS_PER_PREVIEW) return { ok: false, reason: "limite_fotos" };
  // A contagem não trava a tabela: duas conversas ao mesmo tempo podem passar 1 do teto da loja (aceito).
  const quota = tryOnQuotaVerdict({
    customerToday: today.customer,
    totalToday: today.total,
    perCustomerDaily: settings.perCustomerDaily,
    dailyTotal: settings.dailyTotal,
  });
  if (!quota.ok) return { ok: false, reason: quota.reason };

  assertTryOnTransition(from, "queued");
  try {
    // Savepoint: o conflito do índice "uma prévia por conversa" não pode envenenar a transação do turno.
    return await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(tryonRequests)
        .set({ status: "queued", photoWaMessageId: photo.id, queuedAt: input.now, updatedAt: input.now })
        .where(and(eq(tryonRequests.id, request.id), eq(tryonRequests.status, from)))
        .returning({ id: tryonRequests.id });
      if (!updated) return { ok: false as const, reason: "estado_invalido" as const };
      const eventId = await enqueueOutboxEvent(
        tx,
        {
          eventType: TRYON_EVENT,
          // Pela vez na fila: a prévia reaberta (foto nova) ganha um evento novo.
          dedupeKey: `${TRYON_EVENT}:${request.id}:${input.now.getTime()}`,
          aggregateType: "tryon_request",
          aggregateId: request.id,
          payload: { requestId: request.id },
        },
        { kick: input.kick ?? true },
      );
      return { ok: true as const, eventId };
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, reason: "em_andamento" };
    throw error;
  }
}
