// Retornos combinados: agendar (na transação do turno, com o evento da fila
// para o horário), cancelar (dona, cliente, sistema), listar para o painel e
// para o caderninho, e as marcações que o turno proativo faz. Quem decide o
// quê é o core (core/bot/followup.ts); aqui é banco + fila.
import { and, asc, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { FollowupKind } from "@/core/bot/followup";
import { followupMemoryLine, idleCartReason, isIdleCartCandidate } from "@/core/bot/followup";
import { parseBotState } from "@/core/bot/memory";
import { isWithinSendWindow, nextSendWindowStart } from "@/core/whatsapp/send-window";
import { auditLog, customers, orders, settings, waConversations, waFollowups, waSuggestions } from "@/db/schema";
import { loadSendPolicy } from "@/services/wa-send-policy";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";

export const BOT_FOLLOWUP_EVENT = "wa.bot_followup";
export const botFollowupPayloadSchema = z.object({ followupId: z.uuid() });

export type FollowupCancelReason =
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
  const cutoff = new Date(now.getTime() - hours * 3_600_000);
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
    })
    .from(waConversations)
    .leftJoin(customers, eq(customers.id, waConversations.customerId))
    .where(
      and(
        eq(waConversations.status, "open"),
        lt(waConversations.lastInboundAt, cutoff),
        sql`jsonb_array_length(coalesce(${waConversations.botState} -> 'cart', '[]'::jsonb)) > 0`,
        // Nunca duas retomadas: a linha idle_cart existe uma vez por conversa.
        sql`NOT EXISTS (SELECT 1 FROM ${waFollowups} WHERE ${waFollowups.conversationId} = ${waConversations.id} AND ${waFollowups.kind} = 'idle_cart')`,
        or(isNull(waConversations.botDisabledUntil), lt(waConversations.botDisabledUntil, now)),
      ),
    )
    .limit(200);
  const policy = await loadSendPolicy(db);
  const dueAt = isWithinSendWindow(now, policy.window) ? now : nextSendWindowStart(now, policy.window);
  let scheduled = 0;
  for (const row of rows) {
    const cart = parseBotState(row.botState).cart ?? [];
    let orderedAfter = false;
    if (row.customerId && row.lastInboundAt) {
      const [order] = await db
        .select({ id: orders.id })
        .from(orders)
        .where(and(eq(orders.customerId, row.customerId), gt(orders.createdAt, row.lastInboundAt)))
        .limit(1);
      orderedAfter = order !== undefined;
    }
    const candidate = isIdleCartCandidate({
      status: row.status,
      botDisabledUntil: row.botDisabledUntil,
      cartCount: cart.length,
      lastInboundAt: row.lastInboundAt,
      lastOutboundAt: row.lastOutboundAt,
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
        customerId: row.customerId,
        kind: "idle_cart",
        reason: idleCartReason(cart.length),
        dueAt,
        requestedBy: "system",
        now,
      });
      scheduled += 1;
    } catch (error) {
      // Corrida entre duas rodadas: o UNIQUE recusou a segunda — a primeira já agendou.
      console.warn(`[idle-cart] conversa ${row.id} não agendada:`, error instanceof Error ? error.message : error);
    }
  }
  return { hours, checked: rows.length, scheduled };
}
