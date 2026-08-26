"use server";

// Ações do chat de atendimento. Sem revalidatePath de propósito: o poll de
// 3 segundos já atualiza a tela, e revalidar aqui forçaria um refetch RSC
// inteiro a cada envio de mensagem.
import { z } from "zod";

import { getDb } from "@/db/client";
import { requireUser } from "@/services/auth";
import { ServiceError } from "@/services/settings";
import {
  markConversationSeen,
  returnWaConversationToBot,
  sendManualWaReply,
  takeOverWaConversation,
} from "@/services/wa-conversations";

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
