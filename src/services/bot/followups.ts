// Executor de agendar_retorno: a Lia só chega aqui depois do "sim" da
// cliente (regra do prompt + campo obrigatório); o executor confere que a
// última mensagem dela parece um sim, planeja o horário dentro da janela e
// agenda na transação do turno.
import { and, desc, eq, lt } from "drizzle-orm";

import { askedToCallBack, FOLLOWUP_PLAN_ERRORS, followupWhenLabel, isReturnRequest, looksLikeConsent, planFollowup } from "@/core/bot/followup";
import type { BotToolInputs } from "@/core/bot/tools";
import { waMessages } from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { spDayKey, spWeekdayName } from "@/lib/sp-day";
import { loadSendPolicy } from "@/services/wa-send-policy";
import { scheduleBotFollowup } from "@/services/wa-followups";

import { DRY_RUN_TEXT, type BotExecutorContext, type ToolResult } from "./shared";

export async function execAgendarRetorno(
  db: DbOrTx,
  ctx: BotExecutorContext,
  input: BotToolInputs["agendar_retorno"],
): Promise<ToolResult> {
  if (ctx.dryRun) return { ok: true, text: DRY_RUN_TEXT };
  if (ctx.proactive) {
    return { ok: false, text: "Você iniciou esta conversa (retorno combinado): não agende outro retorno agora. Se ela responder e pedir, aí sim — com um sim novo." };
  }
  const now = ctx.now ?? new Date();
  // O sim precisa estar na última mensagem DELA: sem ele, pergunte de novo.
  const [lastInbound] = await db
    .select({ id: waMessages.id, body: waMessages.body, kind: waMessages.kind, createdAt: waMessages.createdAt })
    .from(waMessages)
    .where(and(eq(waMessages.conversationId, ctx.conversationId), eq(waMessages.direction, "inbound")))
    .orderBy(desc(waMessages.createdAt), desc(waMessages.id))
    .limit(1);
  // Consentimento = ela mesma pediu ("me chama amanhã às 10") OU um sim curto
  // logo depois de a Lia perguntar "posso te chamar …?". Só texto ou áudio (o
  // body é a transcrição); foto, lista ou figurinha não são consentimento.
  const spoken = lastInbound && (lastInbound.kind === "text" || lastInbound.kind === "audio") ? lastInbound.body : null;
  let consented = spoken !== null && isReturnRequest(spoken);
  if (!consented && lastInbound && spoken !== null && looksLikeConsent(spoken)) {
    const [lastOutbound] = await db
      .select({ body: waMessages.body })
      .from(waMessages)
      .where(and(eq(waMessages.conversationId, ctx.conversationId), eq(waMessages.direction, "outbound"), lt(waMessages.createdAt, lastInbound.createdAt)))
      .orderBy(desc(waMessages.createdAt), desc(waMessages.id))
      .limit(1);
    consented = lastOutbound !== undefined && askedToCallBack(lastOutbound.body);
  }
  if (!lastInbound || !consented) {
    return { ok: false, text: 'Ainda não há um sim dela a uma pergunta sua. Pergunte em 1 frase se pode chamá-la ("posso te chamar amanhã às 10h?") e só agende quando ela responder sim — ou quando ela mesma pedir para ser chamada.' };
  }
  const policy = await loadSendPolicy(db);
  const plan = planFollowup({ date: input.data, time: input.hora, now, window: policy.window });
  if (!plan.ok) {
    // O modelo pode não saber que dia é hoje (caderninho vazio): diga.
    const today = spDayKey(now);
    return { ok: false, text: `${FOLLOWUP_PLAN_ERRORS[plan.reason]} Hoje é ${spWeekdayName(today)}, ${today} (São Paulo).` };
  }
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
