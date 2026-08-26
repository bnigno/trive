"use server";

// Ações da caixa de e-mail. Sem revalidatePath de propósito: o poll da tela
// já traz a novidade sozinho, e revalidar aqui forçaria um refetch RSC
// inteiro (lista + conversa) a cada resposta enviada.
import { z } from "zod";

import { getDb } from "@/db/client";
import { requireUser } from "@/services/auth";
import {
  archiveThread,
  markThreadSeen,
  reopenThread,
  sendEmailReply,
} from "@/services/email-inbox";
import { ServiceError } from "@/services/settings";

export type ActionResult = { ok: true } | { error: string };

// Fronteira de server action: o que chega aqui vem do navegador e é parseado,
// nunca convertido na marra.
const threadIdSchema = z.uuid("Conversa não encontrada.");
const replyBodySchema = z
  .string()
  .trim()
  .min(1, "Escreva a mensagem antes de enviar.")
  .max(10000, "A mensagem deve ter no máximo 10000 caracteres.");

function toErrorMessage(error: unknown): string {
  if (error instanceof ServiceError) return error.message;
  if (error instanceof z.ZodError) {
    return error.issues[0]?.message ?? "Dados inválidos. Confira os campos.";
  }
  return "Algo deu errado, tente novamente.";
}

export async function sendEmailReplyAction(
  threadId: string,
  body: string,
): Promise<ActionResult> {
  const user = await requireUser();
  try {
    await sendEmailReply(getDb(), {
      threadId: threadIdSchema.parse(threadId),
      userId: user.id,
      body: replyBodySchema.parse(body),
    });
    return { ok: true };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

export async function archiveEmailThreadAction(
  threadId: string,
): Promise<ActionResult> {
  const user = await requireUser();
  try {
    await archiveThread(getDb(), {
      threadId: threadIdSchema.parse(threadId),
      userId: user.id,
    });
    return { ok: true };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

export async function reopenEmailThreadAction(
  threadId: string,
): Promise<ActionResult> {
  const user = await requireUser();
  try {
    await reopenThread(getDb(), {
      threadId: threadIdSchema.parse(threadId),
      userId: user.id,
    });
    return { ok: true };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

/**
 * "Visto" é telemetria de leitura: falhar não pode atrapalhar o atendimento,
 * então o erro vira `{ ok: false }` silencioso (sem mensagem para a tela).
 * O requireUser fica FORA do try para o redirect de sessão expirada propagar.
 */
export async function markEmailThreadSeenAction(
  threadId: string,
): Promise<{ ok: boolean }> {
  await requireUser();
  try {
    await markThreadSeen(getDb(), { threadId: threadIdSchema.parse(threadId) });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
