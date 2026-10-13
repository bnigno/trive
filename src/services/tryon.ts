// "Me vê com ela" — a parte leve: o evento da fila, quanto já foi feito hoje
// e o passo que põe um pedido aceito na fila. O trabalho pesado (FASHN,
// portões, envio) fica em services/tryon-generate.ts, que só a fila importa.
import { and, eq, gte, ne, sql } from "drizzle-orm";
import { z } from "zod";

import { assertTryOnTransition, isTryOnStatus, type TryOnStatus } from "@/core/tryon/status";
import { tryOnQuotaVerdict } from "@/core/tryon/rules";
import { tryonRequests } from "@/db/schema";
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
 * Prévias que entraram na fila hoje (dia de São Paulo) — da cliente e da
 * loja. Foto recusada na checagem não conta: nada foi pedido à FASHN.
 */
export async function countTryOnsToday(db: DbOrTx, input: { phoneE164: string; now: Date }): Promise<{ customer: number; total: number }> {
  const since = spDayStart(spDayKey(input.now));
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      customer: sql<number>`count(*) filter (where ${tryonRequests.phoneE164} = ${input.phoneE164})::int`,
    })
    .from(tryonRequests)
    .where(and(gte(tryonRequests.queuedAt, since), ne(tryonRequests.status, "photo_rejected")));
  return { customer: row?.customer ?? 0, total: row?.total ?? 0 };
}

export type QueueTryOnResult =
  | { ok: true; eventId: string | null }
  | {
      ok: false;
      reason: "nao_encontrado" | "sem_consentimento" | "estado_invalido" | "desligado" | "limite_cliente" | "limite_loja" | "em_andamento";
    };

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown; cause?: { code?: unknown } } | null)?.code ?? (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return code === "23505";
}

/**
 * Pedido ACEITO (ela tocou "Quero me ver") + a foto dela → na fila. Confere
 * o interruptor e os tetos do dia ANTES de gastar. Dentro do turno da Lia
 * (a transação dela), passe kick: false — quem chama dá o kick depois do
 * commit com o eventId devolvido.
 */
export async function queueTryOn(
  db: DbOrTx,
  input: { requestId: string; photoWaMessageId: string; now: Date; kick?: boolean },
): Promise<QueueTryOnResult> {
  const [request] = await db.select().from(tryonRequests).where(eq(tryonRequests.id, input.requestId)).limit(1);
  if (!request || !isTryOnStatus(request.status)) return { ok: false, reason: "nao_encontrado" };
  if (!request.acceptedAt) return { ok: false, reason: "sem_consentimento" };
  const from: TryOnStatus = request.status;
  if (from !== "offered" && from !== "awaiting_photo" && from !== "declined") return { ok: false, reason: "estado_invalido" };

  const settings = await loadTryOnSettings(db);
  if (!settings.enabled) return { ok: false, reason: "desligado" };
  const today = await countTryOnsToday(db, { phoneE164: request.phoneE164, now: input.now });
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
        .set({ status: "queued", photoWaMessageId: input.photoWaMessageId, queuedAt: input.now, updatedAt: input.now })
        .where(and(eq(tryonRequests.id, request.id), eq(tryonRequests.status, from)))
        .returning({ id: tryonRequests.id });
      if (!updated) return { ok: false as const, reason: "estado_invalido" as const };
      const eventId = await enqueueOutboxEvent(
        tx,
        {
          eventType: TRYON_EVENT,
          dedupeKey: `${TRYON_EVENT}:${request.id}`,
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
