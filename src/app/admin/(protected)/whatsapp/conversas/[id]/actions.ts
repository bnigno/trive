"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getDb } from "@/db/client";
import { requireUser } from "@/services/auth";
import { ServiceError } from "@/services/settings";
import {
  returnWaConversationToBot,
  sendManualWaReply,
  takeOverWaConversation,
} from "@/services/wa-conversations";

export type FormState = { error?: string; success?: string };

function toErrorMessage(error: unknown): string {
  if (error instanceof ServiceError) return error.message;
  if (error instanceof z.ZodError) {
    return error.issues[0]?.message ?? "Dados inválidos. Confira os campos.";
  }
  return "Algo deu errado, tente novamente.";
}

function conversationIdFrom(formData: FormData): string {
  return String(formData.get("conversationId") ?? "");
}

export async function takeOverConversationAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  const conversationId = conversationIdFrom(formData);
  try {
    await takeOverWaConversation(getDb(), {
      conversationId,
      userId: user.id,
    });
    revalidatePath(`/admin/whatsapp/conversas/${conversationId}`);
    revalidatePath("/admin/whatsapp/conversas");
    return {
      success:
        "Conversa assumida — o robô parou de responder aqui. As mensagens do cliente agora chegam no seu WhatsApp.",
    };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

export async function returnConversationToBotAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  const conversationId = conversationIdFrom(formData);
  try {
    await returnWaConversationToBot(getDb(), {
      conversationId,
      userId: user.id,
    });
    revalidatePath(`/admin/whatsapp/conversas/${conversationId}`);
    revalidatePath("/admin/whatsapp/conversas");
    return {
      success:
        "Conversa devolvida ao robô — ele volta a responder na próxima mensagem do cliente.",
    };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

export async function sendManualReplyAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  const conversationId = conversationIdFrom(formData);
  try {
    await sendManualWaReply(getDb(), {
      conversationId,
      userId: user.id,
      body: String(formData.get("body") ?? ""),
    });
    revalidatePath(`/admin/whatsapp/conversas/${conversationId}`);
    revalidatePath("/admin/whatsapp/conversas");
    return {
      success:
        "Mensagem na fila de envio — ela aparece na conversa em instantes. A conversa ficou com você; devolva ao robô quando terminar.",
    };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}
