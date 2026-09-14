// Executor de agendar_retorno: a Lia só chega aqui depois do "sim" da
// cliente (regra do prompt + campo obrigatório); o executor confere que a
// última mensagem dela parece um sim, planeja o horário dentro da janela e
// agenda na transação do turno.
import { and, desc, eq } from "drizzle-orm";

import { FOLLOWUP_PLAN_ERRORS, followupWhenLabel, looksLikeConsent, planFollowup } from "@/core/bot/followup";
import type { BotToolInputs } from "@/core/bot/tools";
import { waMessages } from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { loadSendPolicy } from "@/services/wa-send-policy";
import { scheduleBotFollowup } from "@/services/wa-followups";

import { DRY_RUN_TEXT, type BotExecutorContext, type ToolResult } from "./shared";

export async function execAgendarRetorno(
  db: DbOrTx,
  ctx: BotExecutorContext,
  input: BotToolInputs["agendar_retorno"],
): Promise<ToolResult> {
  if (ctx.dryRun) return { ok: true, text: DRY_RUN_TEXT };
  const now = ctx.now ?? new Date();
  // O sim precisa estar na última mensagem DELA: sem ele, pergunte de novo.
  const [lastInbound] = await db
    .select({ id: waMessages.id, body: waMessages.body, kind: waMessages.kind })
    .from(waMessages)
    .where(and(eq(waMessages.conversationId, ctx.conversationId), eq(waMessages.direction, "inbound")))
    .orderBy(desc(waMessages.createdAt), desc(waMessages.id))
    .limit(1);
  if (!lastInbound || (lastInbound.kind === "text" && !looksLikeConsent(lastInbound.body))) {
    return { ok: false, text: "A última mensagem dela não é um sim claro. Pergunte em 1 frase se pode chamá-la (com o horário) e só agende quando ela responder sim." };
  }
  const policy = await loadSendPolicy(db);
  const plan = planFollowup({ date: input.data, time: input.hora, now, window: policy.window });
  if (!plan.ok) return { ok: false, text: FOLLOWUP_PLAN_ERRORS[plan.reason] };
  const { replaced } = await scheduleBotFollowup(db, {
    conversationId: ctx.conversationId,
    phoneE164: ctx.phoneE164,
    customerId: ctx.customerId,
    kind: "customer",
    reason: input.motivo,
    dueAt: plan.dueAt,
    consentWaMessageId: lastInbound.id,
    requestedBy: "lia",
    now,
  });
  const when = followupWhenLabel(plan.dueAt);
  const adjusted =
    plan.adjusted === "janela_inicio"
      ? ` (ajustado para a abertura, ${policy.window.startHour}h — avise em 1 frase)`
      : plan.adjusted === "dia_seguinte"
        ? ` (depois das ${policy.window.endHour}h não mandamos mensagem: ajustado para o dia seguinte às ${policy.window.startHour}h — avise em 1 frase)`
        : "";
  return {
    ok: true,
    text: `Retorno combinado para ${when}${adjusted}${replaced ? " — substitui o combinado anterior" : ""}. Confirme em 1 frase e encerre por aqui; a maison chama por você no horário.`,
  };
}
