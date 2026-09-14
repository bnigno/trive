"use server";

// Ações do chat de atendimento. Sem revalidatePath de propósito: o poll de
// 3 segundos já atualiza a tela, e revalidar aqui forçaria um refetch RSC
// inteiro a cada envio de mensagem.
import { z } from "zod";

import { getDb } from "@/db/client";
import { requireUser } from "@/services/auth";
import { ServiceError } from "@/services/settings";
import {
  closeWaConversation,
  markConversationSeen,
  returnWaConversationToBot,
  sendManualWaReply,
  takeOverWaConversation,
} from "@/services/wa-conversations";
import { cancelBotFollowup } from "@/services/wa-followups";
import { approveSuggestion, discardSuggestion, setConversationBotMode } from "@/services/wa-suggestions";

export type ActionResult = { ok: true } | { error: string };

function toErrorMessage(error: unknown): string {
  if (error instanceof ServiceError) return error.message;
  if (error instanceof z.ZodError) {
    return error.issues[0]?.message ?? "Dados inválidos. Confira os campos.";
  }
  return "Algo deu errado, tente novamente.";
}

export async function takeOverConversationAction(
  conversationId: string,
): Promise<ActionResult> {
  const user = await requireUser();
  try {
    await takeOverWaConversation(getDb(), { conversationId, userId: user.id });
    return { ok: true };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

export async function returnConversationToBotAction(
  conversationId: string,
): Promise<ActionResult> {
  const user = await requireUser();
  try {
    await returnWaConversationToBot(getDb(), {
      conversationId,
      userId: user.id,
    });
    return { ok: true };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

export async function closeConversationAction(
  conversationId: string,
): Promise<ActionResult> {
  const user = await requireUser();
  try {
    await closeWaConversation(getDb(), { conversationId, userId: user.id });
    return { ok: true };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

export async function sendManualReplyAction(
  conversationId: string,
  body: string,
): Promise<ActionResult> {
  const user = await requireUser();
  try {
    await sendManualWaReply(getDb(), { conversationId, userId: user.id, body });
    return { ok: true };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

/**
 * "Visto" é telemetria de leitura: falhar não pode atrapalhar o atendimento,
 * então o erro vira `{ ok: false }` silencioso (sem mensagem para a UI).
 * O requireUser fica FORA do try para o redirect de sessão expirada propagar.
 */
/** Copiloto: enviar a sugestão como está ou editada. */
export async function approveSuggestionAction(suggestionId: string, body?: string | null): Promise<ActionResult> {
  const user = await requireUser();
  try {
    await approveSuggestion(getDb(), { suggestionId, userId: user.id, body: body ?? null });
    return { ok: true };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

export async function discardSuggestionAction(suggestionId: string): Promise<ActionResult> {
  const user = await requireUser();
  try {
    const { discarded } = await discardSuggestion(getDb(), { suggestionId, userId: user.id });
    if (!discarded) return { error: "Esta sugestão já foi enviada, descartada ou superada." };
    return { ok: true };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

/** "Só sugerir nesta conversa" / "deixar responder sozinha" / voltar ao modo da loja. */
export async function setConversationBotModeAction(conversationId: string, mode: "autonomous" | "copilot" | null): Promise<ActionResult> {
  const user = await requireUser();
  try {
    await setConversationBotMode(getDb(), { conversationId, mode: z.enum(["autonomous", "copilot"]).nullable().parse(mode), userId: user.id });
    return { ok: true };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

/** "Cancelar retorno": a Lia não vai chamar; a fila encontra o status e não manda nada. */
export async function cancelFollowupAction(followupId: string): Promise<ActionResult> {
  const user = await requireUser();
  try {
    const { canceled } = await cancelBotFollowup(getDb(), { followupId: z.uuid().parse(followupId), reason: "dono", userId: user.id });
    if (!canceled) return { error: "Este retorno já não estava agendado." };
    return { ok: true };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

export async function markConversationSeenAction(
  conversationId: string,
): Promise<{ ok: boolean }> {
  await requireUser();
  try {
    await markConversationSeen(getDb(), { conversationId });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
