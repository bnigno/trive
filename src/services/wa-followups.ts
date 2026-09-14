// Retornos combinados: agendar (na transação do turno, com o evento da fila
// para o horário), cancelar (dona, cliente, sistema), listar para o painel e
// para o caderninho, e as marcações que o turno proativo faz. Quem decide o
// quê é o core (core/bot/followup.ts); aqui é banco + fila.
import { and, asc, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { FollowupKind } from "@/core/bot/followup";
import { followupMemoryLine, IDLE_CART_MAX_AGE_MS, idleCartReason, isIdleCartCandidate } from "@/core/bot/followup";
import { parseBotState } from "@/core/bot/memory";
import { isWithinSendWindow, nextSendWindowStart } from "@/core/whatsapp/send-window";
import { deriveWaMessageOrigin } from "@/core/whatsapp/origin";
import { auditLog, customers, orders, settings, waConversations, waFollowups, waMessages, waSuggestions } from "@/db/schema";
import { isBotEnabled } from "@/services/wa-bot";
import { isWaEnabled } from "@/services/wa-messaging";
import { loadSendPolicy } from "@/services/wa-send-policy";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";

export const BOT_FOLLOWUP_EVENT = "wa.bot_followup";
export const botFollowupPayloadSchema = z.object({ followupId: z.uuid() });

export type FollowupCancelReason =
  | "desligado"
  | "sacola_vazia"
  | "sem_opt_in"
  | "comprou"
  | "dono"
  | "cliente"
  | "substituido"
  | "sair"
  | "conversa_humana"
  | "conversa_fechada"
  | "bot_desligado"
  | "bot_silenciado"
  | "whatsapp_desligado"
  | "sem_resposta"
  | "nao_enviado"
  | "atrasado"
  | "modelo_indisponivel"
  | "superada";

/** O que o painel mostra para cada motivo. */
export const FOLLOWUP_CANCEL_LABELS: Record<FollowupCancelReason, string> = {
  desligado: "a retomada de sacola foi desligada",
  sacola_vazia: "a sacola já estava vazia",
  sem_opt_in: "ela não aceita mais avisos",
  comprou: "ela comprou antes",
  dono: "cancelado por você",
  cliente: "cancelado pela cliente",
  substituido: "substituído por outro horário",
  sair: "ela pediu SAIR",
  conversa_humana: "a conversa estava com você",
  conversa_fechada: "a conversa estava fechada",
  bot_desligado: "a Lia estava desligada",
  bot_silenciado: "a Lia estava silenciada",
  whatsapp_desligado: "o WhatsApp estava desligado",
  sem_resposta: "a Lia não tinha o que dizer",
  nao_enviado: "a mensagem não saiu (número sem WhatsApp?)",
  atrasado: "passou da hora (fila atrasada)",
  modelo_indisponivel: "a inteligência ficou fora do ar",
  superada: "ela voltou antes por conta",
};

export interface ScheduledFollowup {
  id: string;
  kind: FollowupKind;
  reason: string;
  dueAt: Date;
  createdAt: Date;
}

/**
 * Agenda o retorno: cancela o que já estava agendado para a conversa e o
 * mesmo tipo (agendar de novo substitui), insere a linha e enfileira o
 * evento para o horário. Na transação do turno: se o turno cair, nada fica.
 */
export async function scheduleBotFollowup(
  tx: DbOrTx,
  input: {
    conversationId: string;
    phoneE164: string;
    customerId: string | null;
    kind: FollowupKind;
    reason: string;
    dueAt: Date;
    consentWaMessageId?: string | null;
    requestedBy: "lia" | "system";
    now: Date;
  },
): Promise<{ followupId: string; replaced: boolean }> {
  // Tudo numa transação (ou savepoint): se o INSERT bater no UNIQUE (duas
  // rodadas do cron na mesma sacola), o cancelamento do anterior desfaz junto.
  return tx.transaction(async (inner) => scheduleBotFollowupInTx(inner, input));
}

async function scheduleBotFollowupInTx(
  tx: DbOrTx,
  input: {
    conversationId: string;
    phoneE164: string;
    customerId: string | null;
    kind: FollowupKind;
    reason: string;
    dueAt: Date;
    consentWaMessageId?: string | null;
    requestedBy: "lia" | "system";
    now: Date;
  },
): Promise<{ followupId: string; replaced: boolean }> {
  // Só o retorno combinado pela cliente é substituível ("mudei o horário");
  // a retomada da sacola é uma por conversa, para sempre (UNIQUE).
  const previous =
    input.kind === "customer"
      ? await tx
          .update(waFollowups)
          .set({ status: "canceled", canceledAt: input.now, canceledReason: "substituido", updatedAt: input.now })
          .where(and(eq(waFollowups.conversationId, input.conversationId), eq(waFollowups.kind, input.kind), eq(waFollowups.status, "scheduled")))
          .returning({ id: waFollowups.id })
      : [];
  const [row] = await tx
    .insert(waFollowups)
    .values({
      conversationId: input.conversationId,
      phoneE164: input.phoneE164,
      customerId: input.customerId,
      kind: input.kind,
      reason: input.reason,
      dueAt: input.dueAt,
      consentWaMessageId: input.consentWaMessageId ?? null,
      requestedBy: input.requestedBy,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning({ id: waFollowups.id });
  await enqueueOutboxEvent(tx, {
    eventType: BOT_FOLLOWUP_EVENT,
    dedupeKey: `wa.bot_followup:${row.id}`,
    aggregateType: "wa_conversation",
    aggregateId: input.conversationId,
    payload: { followupId: row.id },
    nextAttemptAt: input.dueAt,
  });
  await tx.insert(auditLog).values({
    actorType: "system",
    actorId: null,
    action: "wa.followup_scheduled",
    entityType: "wa_conversation",
    entityId: input.conversationId,
    after: { followupId: row.id, kind: input.kind, dueAt: input.dueAt.toISOString(), reason: input.reason, requestedBy: input.requestedBy, replaced: previous.map((p) => p.id) },
  });
  return { followupId: row.id, replaced: previous.length > 0 };
}

/** Cancela um retorno agendado (a fila encontra o status e não manda nada). */
export async function cancelBotFollowup(
  db: DbOrTx,
  input: { followupId: string; reason: FollowupCancelReason; userId?: string | null; now?: Date },
): Promise<{ canceled: boolean }> {
  const now = input.now ?? new Date();
  const updated = await db
    .update(waFollowups)
    .set({ status: "canceled", canceledAt: now, canceledReason: input.reason, canceledBy: input.userId ?? null, updatedAt: now })
    .where(and(eq(waFollowups.id, input.followupId), eq(waFollowups.status, "scheduled")))
    .returning({ id: waFollowups.id, conversationId: waFollowups.conversationId });
  if (updated.length === 0) return { canceled: false };
  await db.insert(auditLog).values({
    actorType: input.userId ? "user" : "system",
    actorId: input.userId ?? null,
    action: "wa.followup_canceled",
    entityType: "wa_conversation",
    entityId: updated[0].conversationId,
    after: { followupId: input.followupId, reason: input.reason },
  });
  return { canceled: true };
}

/** SAIR: tudo que esse telefone tinha combinado é cancelado — com ou sem cadastro. */
export async function cancelBotFollowupsByPhone(
  db: DbOrTx,
  input: { phoneE164: string; reason: FollowupCancelReason; now?: Date },
): Promise<{ canceled: number }> {
  const now = input.now ?? new Date();
  const updated = await db
    .update(waFollowups)
    .set({ status: "canceled", canceledAt: now, canceledReason: input.reason, updatedAt: now })
    .where(and(eq(waFollowups.phoneE164, input.phoneE164), eq(waFollowups.status, "scheduled")))
    .returning({ id: waFollowups.id, conversationId: waFollowups.conversationId });
  for (const row of updated) {
    await db.insert(auditLog).values({
      actorType: "system",
      actorId: null,
      action: "wa.followup_canceled",
      entityType: "wa_conversation",
      entityId: row.conversationId,
      after: { followupId: row.id, reason: input.reason },
    });
  }
  return { canceled: updated.length };
}

/** Todos os retornos agendados de uma conversa (na prática, um por tipo). */
export async function listScheduledFollowups(db: DbOrTx, conversationId: string): Promise<ScheduledFollowup[]> {
  const rows = await db
    .select({ id: waFollowups.id, kind: waFollowups.kind, reason: waFollowups.reason, dueAt: waFollowups.dueAt, createdAt: waFollowups.createdAt })
    .from(waFollowups)
    .where(and(eq(waFollowups.conversationId, conversationId), eq(waFollowups.status, "scheduled")))
    .orderBy(asc(waFollowups.dueAt));
  return rows.map((row) => ({ ...row, kind: row.kind as FollowupKind }));
}

/** A linha do caderninho enquanto há um retorno combinado pela cliente. */
export async function followupMemoryLines(db: DbOrTx, conversationId: string): Promise<string[]> {
  const rows = await listScheduledFollowups(db, conversationId);
  return rows.filter((row) => row.kind === "customer").map((row) => followupMemoryLine({ dueAt: row.dueAt, reason: row.reason }));
}

export interface FollowupHistoryRow {
  id: string;
  kind: FollowupKind;
  reason: string;
  dueAt: Date;
  status: string;
  canceledReason: string | null;
  sentAt: Date | null;
  createdAt: Date;
  /** Copiloto: o retorno virou sugestão — e o que a dona fez com ela. */
  suggestionStatus: string | null;
}

/** Painel: os últimos retornos da conversa, em qualquer estado. */
export async function listFollowupHistory(db: DbOrTx, conversationId: string, limit = 5): Promise<FollowupHistoryRow[]> {
  const rows = await db
    .select({
      id: waFollowups.id,
      kind: waFollowups.kind,
      reason: waFollowups.reason,
      dueAt: waFollowups.dueAt,
      status: waFollowups.status,
      canceledReason: waFollowups.canceledReason,
      sentAt: waFollowups.sentAt,
      createdAt: waFollowups.createdAt,
      suggestionStatus: waSuggestions.status,
    })
    .from(waFollowups)
    .leftJoin(waSuggestions, eq(waSuggestions.followupId, waFollowups.id))
    .where(eq(waFollowups.conversationId, conversationId))
    .orderBy(desc(waFollowups.createdAt))
    .limit(limit);
  return rows.map((row) => ({ ...row, kind: row.kind as FollowupKind }));
}

export interface IdleCartSweepResult {
  hours: number;
  checked: number;
  scheduled: number;
}

/** Setting bot_idle_cart_followup_hours: 0/ausente = desligado. */
export async function loadIdleCartHours(db: DbOrTx): Promise<number> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, "bot_idle_cart_followup_hours")).limit(1);
  const value = Number(row?.value);
  return Number.isInteger(value) && value > 0 ? value : 0;
}

/**
 * Cron (a cada hora): a sacola parada há N horas vira UMA retomada da Lia —
 * agendada para agora (na janela; fora dela, para a abertura). O core
 * decide quem é candidata; o UNIQUE de wa_followups garante "uma vez por
 * conversa, para sempre" mesmo entre rodadas concorrentes.
 */
export async function scheduleIdleCartFollowups(db: DbOrTx, input: { now?: Date } = {}): Promise<IdleCartSweepResult> {
  const now = input.now ?? new Date();
  const hours = await loadIdleCartHours(db);
  if (hours <= 0) return { hours, checked: 0, scheduled: 0 };
  // Lia ou WhatsApp desligados: agendar agora queimaria a única chance da conversa.
  if (!(await isBotEnabled(db)) || !(await isWaEnabled(db))) return { hours, checked: 0, scheduled: 0 };
  const cutoff = new Date(now.getTime() - hours * 3_600_000);
  const floor = new Date(cutoff.getTime() - IDLE_CART_MAX_AGE_MS);
  // Os filtros baratos vão no SQL (o lote nunca fica preso em não-candidatas
  // eternas) e o core reconfere; opt-in pelo TELEFONE, como o SAIR.
  const rows = await db
    .select({
      id: waConversations.id,
      phoneE164: waConversations.phoneE164,
      customerId: waConversations.customerId,
      status: waConversations.status,
      botDisabledUntil: waConversations.botDisabledUntil,
      botState: waConversations.botState,
      lastInboundAt: waConversations.lastInboundAt,
      lastOutboundAt: waConversations.lastOutboundAt,
      marketingOptIn: customers.marketingOptIn,
      optInCustomerId: customers.id,
    })
    .from(waConversations)
    .innerJoin(customers, and(eq(customers.phoneE164, waConversations.phoneE164), isNull(customers.deletedAt)))
    .where(
      and(
        eq(waConversations.status, "open"),
        eq(customers.marketingOptIn, true),
        lt(waConversations.lastInboundAt, cutoff),
        gt(waConversations.lastInboundAt, floor),
        sql`${waConversations.lastOutboundAt} >= ${waConversations.lastInboundAt}`,
        sql`jsonb_array_length(coalesce(${waConversations.botState} -> 'cart', '[]'::jsonb)) > 0`,
        // Nunca duas retomadas: a linha idle_cart existe uma vez por conversa.
        sql`NOT EXISTS (SELECT 1 FROM ${waFollowups} WHERE ${waFollowups.conversationId} = ${waConversations.id} AND ${waFollowups.kind} = 'idle_cart')`,
        or(isNull(waConversations.botDisabledUntil), lt(waConversations.botDisabledUntil, now)),
      ),
    )
    .orderBy(desc(waConversations.lastInboundAt))
    .limit(200);
  const policy = await loadSendPolicy(db);
  const dueAt = isWithinSendWindow(now, policy.window) ? now : nextSendWindowStart(now, policy.window);
  let scheduled = 0;
  for (const row of rows) {
    const cart = parseBotState(row.botState).cart ?? [];
    let orderedAfter = false;
    if (row.lastInboundAt) {
      const [order] = await db
        .select({ id: orders.id })
        .from(orders)
        .where(and(or(eq(orders.customerId, row.optInCustomerId), row.customerId ? eq(orders.customerId, row.customerId) : sql`false`), gt(orders.createdAt, row.lastInboundAt)))
        .limit(1);
      orderedAfter = order !== undefined;
    }
    // "A Lia respondeu por último" de verdade: a última mensagem é dela (não um aviso automático).
    const [last] = await db
      .select({ direction: waMessages.direction, dedupeKey: waMessages.dedupeKey })
      .from(waMessages)
      .where(eq(waMessages.conversationId, row.id))
      .orderBy(desc(waMessages.createdAt), desc(waMessages.id))
      .limit(1);
    const liaLast = last !== undefined && last.direction === "outbound" && deriveWaMessageOrigin({ direction: "outbound", dedupeKey: last.dedupeKey, templateKey: null }) === "bot";
    const candidate = isIdleCartCandidate({
      status: row.status,
      botDisabledUntil: row.botDisabledUntil,
      cartCount: cart.length,
      lastInboundAt: row.lastInboundAt,
      lastOutboundAt: liaLast ? row.lastOutboundAt : null,
      hasOptIn: row.marketingOptIn === true,
      orderedAfterLastInbound: orderedAfter,
      hours,
      now,
    });
    if (!candidate) continue;
    try {
      await scheduleBotFollowup(db, {
        conversationId: row.id,
        phoneE164: row.phoneE164,
        customerId: row.customerId ?? row.optInCustomerId,
        kind: "idle_cart",
        reason: idleCartReason(cart.length),
        dueAt,
        requestedBy: "system",
        now,
      });
      scheduled += 1;
    } catch (error) {
      // Corrida entre duas rodadas: o UNIQUE recusou a segunda — a primeira já agendou. Qualquer outro erro sobe (o Inngest tenta de novo).
      if (!isUniqueViolation(error)) throw error;
    }
  }
  return { hours, checked: rows.length, scheduled };
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } } | null)?.code ?? (error as { cause?: { code?: string } } | null)?.cause?.code;
  return code === "23505" || /unique|duplicate key/i.test(error instanceof Error ? error.message : String(error));
}

/** Desligar o recurso (0 h) ou tirar o opt-in: as retomadas ainda agendadas caem. */
export async function cancelScheduledIdleCartFollowups(db: DbOrTx, input: { phoneE164?: string; reason: FollowupCancelReason; now?: Date }): Promise<{ canceled: number }> {
  const now = input.now ?? new Date();
  const updated = await db
    .update(waFollowups)
    .set({ status: "canceled", canceledAt: now, canceledReason: input.reason, updatedAt: now })
    .where(and(eq(waFollowups.kind, "idle_cart"), eq(waFollowups.status, "scheduled"), ...(input.phoneE164 ? [eq(waFollowups.phoneE164, input.phoneE164)] : [])))
    .returning({ id: waFollowups.id });
  return { canceled: updated.length };
}

/**
 * Na hora de mandar (turno proativo): a sacola parada ainda é uma sacola
 * parada? Zero carência (qualquer mensagem dela depois do agendamento é
 * "ela voltou"), a sacola ainda tem peças, nenhum pedido depois, opt-in de
 * pé e o recurso ainda ligado. Devolve o motivo para não mandar, ou null.
 */
export async function idleCartStillValid(
  db: DbOrTx,
  input: { conversation: { id: string; phoneE164: string; customerId: string | null; botState: unknown }; followupCreatedAt: Date; lastInboundAt: Date | null },
): Promise<FollowupCancelReason | null> {
  if ((await loadIdleCartHours(db)) <= 0) return "desligado";
  if (input.lastInboundAt && input.lastInboundAt.getTime() > input.followupCreatedAt.getTime()) return "superada";
  if ((parseBotState(input.conversation.botState).cart ?? []).length === 0) return "sacola_vazia";
  const [customer] = await db
    .select({ id: customers.id, marketingOptIn: customers.marketingOptIn })
    .from(customers)
    .where(and(eq(customers.phoneE164, input.conversation.phoneE164), isNull(customers.deletedAt)))
    .limit(1);
  if (!customer || customer.marketingOptIn !== true) return "sem_opt_in";
  const [order] = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(or(eq(orders.customerId, customer.id), input.conversation.customerId ? eq(orders.customerId, input.conversation.customerId) : sql`false`), gt(orders.createdAt, input.followupCreatedAt)))
    .limit(1);
  if (order) return "comprou";
  return null;
}
