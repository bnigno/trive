"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getSalesAssistant } from "@/adapters/assistant";
import { AssistantUnavailableError } from "@/adapters/assistant";
import { getMessagingProvider } from "@/adapters/zapi";
import { getDb } from "@/db/client";
import { requireOwner } from "@/services/auth";
import { ServiceError, updateSetting } from "@/services/settings";
import { sendToOwner, type WaSkipReason } from "@/services/wa-messaging";
import { rehearseBotTurn, type RehearsalTurn } from "@/services/wa-rehearsal";
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
// Interruptores (salvam na hora, sem botão): WhatsApp e vendedora
// ---------------------------------------------------------------------------

const toggleKeySchema = z.enum(["wa_enabled", "bot_enabled"]);

export async function setToggleAction(
  key: string,
  value: boolean,
): Promise<{ ok: true } | { error: string }> {
  const user = await requireOwner("whatsapp");
  try {
    const parsedKey = toggleKeySchema.parse(key);
    await updateSetting(getDb(), { key: parsedKey, value, userId: user.id });
    revalidatePath("/admin/whatsapp");
    return { ok: true };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

// ---------------------------------------------------------------------------
// Conexão (owner_whatsapp_phone / wa_recovery_after_minutes)
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
    return { success: "Configurações da conexão salvas." };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

// ---------------------------------------------------------------------------
// Vendedora (nome, modelo, política de troca, instruções, respostas rápidas)
// ---------------------------------------------------------------------------

export async function saveBotSettingsAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireOwner("whatsapp");
  try {
    const db = getDb();
    const text = (name: string) => String(formData.get(name) ?? "");
    await updateSetting(db, { key: "bot_seller_name", value: text("botSellerName"), userId: user.id });
    await updateSetting(db, { key: "bot_model", value: text("botModel"), userId: user.id });
    await updateSetting(db, {
      key: "store_exchange_policy",
      value: text("storeExchangePolicy"),
      userId: user.id,
    });
    await updateSetting(db, {
      key: "bot_extra_instructions",
      value: text("botExtraInstructions"),
      userId: user.id,
    });
    await updateSetting(db, {
      key: "wa_quick_replies",
      value: text("waQuickReplies"),
      userId: user.id,
    });

    revalidatePath("/admin/whatsapp");
    revalidatePath("/admin/whatsapp/conversas");
    return { success: "Ficha da vendedora salva. Vale a partir da próxima mensagem." };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

// ---------------------------------------------------------------------------
// Ensaio: "Testar a vendedora" (API real, sem efeito externo)
// ---------------------------------------------------------------------------

const rehearsalInputSchema = z.object({
  history: z.array(
    z.object({ role: z.enum(["user", "assistant"]), text: z.string() }),
  ),
  message: z.string(),
});

export type RehearsalResult = { ok: true; turn: RehearsalTurn } | { error: string };

export async function rehearseBotAction(input: unknown): Promise<RehearsalResult> {
  await requireOwner("whatsapp");
  try {
    const parsed = rehearsalInputSchema.parse(input);
    const turn = await rehearseBotTurn(getDb(), getSalesAssistant(), parsed);
    return { ok: true, turn };
  } catch (error) {
    if (error instanceof AssistantUnavailableError) {
      return {
        error:
          "A vendedora não respondeu: a chave da Anthropic não está configurada na hospedagem ou a API está fora do ar. Tente de novo em instantes.",
      };
    }
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
    "O envio está desligado — ligue o interruptor do WhatsApp (em modo real, confira também as credenciais Z-API na hospedagem) antes de testar.",
  sem_telefone_dono:
    "Cadastre seu número de WhatsApp e salve antes de enviar o teste.",
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
      bodyOverride: "Teste do TRIVÉ ✓ — seu WhatsApp de avisos está funcionando.",
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
        "Não conseguimos falar com o WhatsApp agora. A mensagem ficou na fila e será reenviada; verifique a conexão acima.",
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
    return { success: "Mensagem salva." };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}
