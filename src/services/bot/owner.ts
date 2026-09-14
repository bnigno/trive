// Canal com a equipe: transferência para humano e avisos ao dono.
import { eq } from "drizzle-orm";
import type { BotToolInputs } from "@/core/bot/tools";
import { DEFAULT_HANDOFF_SILENCE_HOURS, hoursSetting, silenceUntil } from "@/core/whatsapp/handoff";
import { auditLog, waConversations } from "@/db/schema";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";
import { getSettingsMap } from "@/services/settings";
import { supersedePendingSuggestions } from "@/services/wa-suggestions";

import { DRY_RUN_TEXT, loadBotState } from "./shared";
import type { BotExecutorContext, ToolResult } from "./shared";

/**
 * Transfere a conversa para atendimento humano: status 'human', bot em
 * silêncio pelas horas de handoff_silence_hours (padrão 24), audit (com o
 * resumo para a equipe) e aviso ao dono via outbox. Compartilhado entre a ferramenta transferir_para_atendente e o
 * fallback de IA indisponível.
 */
export async function handOffToHuman(
  db: DbOrTx,
  ctx: { conversationId: string; phoneE164: string; lastInboundId: string },
  motivo: string,
  resumo?: string,
): Promise<void> {
  const now = new Date();
  const settings = await getSettingsMap(db, ["handoff_silence_hours"]);
  const silenceHours = hoursSetting(settings["handoff_silence_hours"], DEFAULT_HANDOFF_SILENCE_HOURS, {
    min: 1,
  });
  const botDisabledUntil = silenceUntil(now, silenceHours);

  const state = await loadBotState(db, ctx.conversationId);
  await db
    .update(waConversations)
    .set({
      status: "human",
      botDisabledUntil,
      updatedAt: now,
      botState: {
        ...state,
        handoff: {
          motivo,
          ...(resumo ? { resumo } : {}),
          at: now.toISOString(),
        },
      },
    })
    .where(eq(waConversations.id, ctx.conversationId));

  // A sugestão pendente do copiloto perde o sentido quando a dona assume.
  await supersedePendingSuggestions(db, ctx.conversationId, now);

  await db.insert(auditLog).values({
    actorType: "system",
    actorId: null,
    action: "wa.bot_handoff",
    entityType: "wa_conversation",
    entityId: ctx.conversationId,
    after: {
      motivo,
      ...(resumo ? { resumo } : {}),
      botDisabledUntil: botDisabledUntil.toISOString(),
      silenceHours,
    },
    reason: motivo,
  });

  await enqueueOutboxEvent(db, {
    eventType: "wa.owner_forward",
    // Determinístico pela última inbound: o retry do turno (ou o rollback da
    // transação) nunca duplica o aviso ao dono.
    dedupeKey: `wa.handoff:${ctx.conversationId}:${ctx.lastInboundId}`,
    aggregateType: "wa_conversation",
    aggregateId: ctx.conversationId,
    payload: {
      phoneE164: ctx.phoneE164,
      body: [
        `🤖→👤 A vendedora passou a conversa com ${ctx.phoneE164} para você: ${motivo}.`,
        ...(resumo ? [resumo] : []),
        "Responda pelo painel ou aqui mesmo.",
      ].join("\n"),
      raw: true,
    },
  });
}

/**
 * Aviso interno ao dono (ex.: "cliente diz que já fez o Pix"). Sai via outbox
 * (nunca inline) com dedupe pela última inbound — retry do turno não duplica.
 */
export async function execAvisarDono(
  db: DbOrTx,
  ctx: BotExecutorContext,
  input: BotToolInputs["avisar_dono"],
): Promise<ToolResult> {
  if (ctx.dryRun) return { ok: true, text: DRY_RUN_TEXT };

  await enqueueOutboxEvent(db, {
    eventType: "wa.owner_forward",
    dedupeKey: `wa.avisar_dono:${ctx.lastInboundId}`,
    aggregateType: "wa_conversation",
    aggregateId: ctx.conversationId,
    payload: {
      phoneE164: ctx.phoneE164,
      body: `📢 Aviso da vendedora: ${input.mensagem}`,
      raw: true,
    },
  });
  return {
    ok: true,
    text: "Aviso enviado ao dono da loja. Diga ao cliente que o dono confere e confirma — NUNCA afirme que o pagamento já foi confirmado.",
  };
}

export async function execTransferir(
  db: DbOrTx,
  ctx: BotExecutorContext,
  input: BotToolInputs["transferir_para_atendente"],
): Promise<ToolResult> {
  if (ctx.dryRun) return { ok: true, text: DRY_RUN_TEXT };

  await handOffToHuman(
    db,
    {
      conversationId: ctx.conversationId,
      phoneE164: ctx.phoneE164,
      lastInboundId: ctx.lastInboundId,
    },
    input.motivo,
    input.resumo?.trim() || undefined,
  );
  return { ok: true, text: "transferido", endsTurn: true };
}

// ---------------------------------------------------------------------------
// buildToolExecutor
// ---------------------------------------------------------------------------
