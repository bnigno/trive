// Retornos combinados: agendar (na transação do turno, com o evento da fila
// para o horário), cancelar (dona, cliente, sistema), listar para o painel e
// para o caderninho, e as marcações que o turno proativo faz. Quem decide o
// quê é o core (core/bot/followup.ts); aqui é banco + fila.
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";

import type { FollowupKind } from "@/core/bot/followup";
import { followupMemoryLine } from "@/core/bot/followup";
import { auditLog, waFollowups } from "@/db/schema";
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
  const previous = await tx
    .update(waFollowups)
    .set({ status: "canceled", canceledAt: input.now, canceledReason: "substituido", updatedAt: input.now })
    .where(and(eq(waFollowups.conversationId, input.conversationId), eq(waFollowups.kind, input.kind), eq(waFollowups.status, "scheduled")))
    .returning({ id: waFollowups.id });
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
    })
    .from(waFollowups)
    .where(eq(waFollowups.conversationId, conversationId))
    .orderBy(desc(waFollowups.createdAt))
    .limit(limit);
  return rows.map((row) => ({ ...row, kind: row.kind as FollowupKind }));
}
