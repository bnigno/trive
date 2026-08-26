"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getMessagingProvider } from "@/adapters/zapi";
import { getDb } from "@/db/client";
import { requireOwner } from "@/services/auth";
import { ServiceError, updateSetting } from "@/services/settings";
import { sendToOwner, type WaSkipReason } from "@/services/wa-messaging";
import { updateWaTemplate } from "@/services/wa-templates";

export type FormState = { error?: string; success?: string };

function toErrorMessage(error: unknown): string {
  if (error instanceof ServiceError) return error.message;
  if (error instanceof z.ZodError) {
    return error.issues[0]?.message ?? "Dados inválidos. Confira os campos.";
  }
  return "Algo deu errado, tente novamente.";
}

// ---------------------------------------------------------------------------
// Configuração (settings wa_enabled / owner_whatsapp_phone /
// wa_recovery_after_minutes)
// ---------------------------------------------------------------------------

export async function saveWaSettingsAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireOwner("whatsapp");
  try {
    const rawMinutes = String(formData.get("recoveryAfterMinutes") ?? "").trim();
    const minutes = Number(rawMinutes);
    if (!Number.isSafeInteger(minutes)) {
      throw new ServiceError(
        "numero_invalido",
        "Minutos para o lembrete: informe um número inteiro, ex.: 60.",
      );
    }

    const db = getDb();
    await updateSetting(db, {
      key: "wa_enabled",
      value: formData.get("waEnabled") === "on",
      userId: user.id,
    });
    await updateSetting(db, {
      key: "owner_whatsapp_phone",
      value: String(formData.get("ownerWhatsappPhone") ?? ""),
      userId: user.id,
    });
    await updateSetting(db, {
      key: "wa_recovery_after_minutes",
      value: minutes,
      userId: user.id,
    });

    revalidatePath("/admin/whatsapp");
    return { success: "Configurações do WhatsApp salvas." };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

// ---------------------------------------------------------------------------
// Vendedor com IA (bot_enabled / bot_model / bot_extra_instructions)
// ---------------------------------------------------------------------------

export async function saveBotSettingsAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireOwner("whatsapp");
  try {
    const db = getDb();
    await updateSetting(db, {
      key: "bot_enabled",
      value: formData.get("botEnabled") === "on",
      userId: user.id,
    });
    await updateSetting(db, {
      key: "bot_model",
      value: String(formData.get("botModel") ?? ""),
      userId: user.id,
    });
    await updateSetting(db, {
      key: "bot_extra_instructions",
      value: String(formData.get("botExtraInstructions") ?? ""),
      userId: user.id,
    });

    revalidatePath("/admin/whatsapp");
    return { success: "Configurações do vendedor com IA salvas." };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

// ---------------------------------------------------------------------------
// Mensagem de teste para o dono
// ---------------------------------------------------------------------------

const SKIP_REASON_MESSAGES: Record<WaSkipReason, string> = {
  numero_sem_whatsapp:
    "Este número não tem WhatsApp ativo — confira se digitou certo (com DDD).",
  desabilitado:
    "O envio está desativado — ative o WhatsApp acima (em modo real, confira também as credenciais Z-API na hospedagem) e salve antes de testar.",
  sem_telefone_dono:
    "Cadastre seu número de WhatsApp acima e salve antes de enviar o teste.",
  ja_enviado: "Esta mensagem de teste já havia sido enviada.",
  sem_opt_in: "O destinatário não autorizou receber mensagens.",
  sem_template: "O modelo de mensagem não existe ou está inativo.",
};

export async function sendTestMessageAction(
  _prev: FormState,
  _formData: FormData,
): Promise<FormState> {
  await requireOwner("whatsapp");
  try {
    const result = await sendToOwner(getDb(), getMessagingProvider(), {
      bodyOverride: "Teste do TRIVË ✓ — seu WhatsApp de avisos está funcionando.",
      dedupeKey: `wa.test:${Date.now()}`,
    });

    revalidatePath("/admin/whatsapp");
    if ("sent" in result) {
      return {
        success:
          "Mensagem de teste enviada! Confira o WhatsApp do seu número em instantes.",
      };
    }
    return {
      error: `A mensagem não foi enviada. ${SKIP_REASON_MESSAGES[result.skipped]}`,
    };
  } catch (error) {
    if (error instanceof ServiceError || error instanceof z.ZodError) {
      return { error: toErrorMessage(error) };
    }
    // Falha real do provedor: a mensagem ficou na fila como 'failed' e será
    // retomada — para o dono, basta saber que não saiu agora.
    return {
      error:
        "Não conseguimos falar com o WhatsApp agora. A mensagem ficou na fila e será reenviada; verifique a conexão no card de status.",
    };
  }
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export async function updateWaTemplateAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireOwner("whatsapp");
  try {
    await updateWaTemplate(getDb(), {
      key: String(formData.get("key") ?? ""),
      bodyTemplate: String(formData.get("bodyTemplate") ?? ""),
      isActive: formData.get("isActive") === "on",
      userId: user.id,
    });
    revalidatePath("/admin/whatsapp");
    return { success: "Modelo de mensagem salvo." };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}
