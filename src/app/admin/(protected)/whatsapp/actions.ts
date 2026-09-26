"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getSalesAssistant } from "@/adapters/assistant";
import { AssistantUnavailableError } from "@/adapters/assistant";
import { getMessagingProvider } from "@/adapters/zapi";
import { getDb } from "@/db/client";
import { parseBRLToCents } from "@/lib/money";
import { requireOwner } from "@/services/auth";
import { ServiceError, updateSetting } from "@/services/settings";
import { cancelScheduledIdleCartFollowups } from "@/services/wa-followups";
import { supersedeAllPendingSuggestions } from "@/services/wa-suggestions";
import { sendToOwner, type WaSkipReason } from "@/services/wa-messaging";
import { getFileStorage } from "@/adapters/storage";
import { renderCardPng } from "@/cards/render";
import { loadReceiptAssets } from "@/receipts/assets";
import { renderDailyDigestPng } from "@/receipts/render-digest";
import { sendDailyDigestWa, yesterdaySpDayKey } from "@/services/daily-digest";
import { rehearseBotTurn, type RehearsalTurn } from "@/services/wa-rehearsal";
import { updateWaTemplate } from "@/services/wa-templates";
import { INTERVIEW_PROBLEM_TEXT, requestCuratorInterviewNow, saveInterviewSchedule } from "@/services/curator-interviews";

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

const toggleKeySchema = z.enum([
  "wa_enabled",
  "bot_enabled",
  "owner_digest_enabled",
  "bot_media_enabled",
  "bot_photo_match_enabled",
  "bot_cards_enabled",
  "catalog_draft_enabled",
  "atelier_enabled",
  "feedback_ask_enabled",
  "customer_looks_enabled",
  "bot_audio_notes_enabled",
  "groups_enabled",
  "bot_group_mentions_enabled",
  "lia_gift_enabled",
  "provador_welcome_gift_enabled",
  "ai_photos_enabled",
  "ai_photos_in_store",
  "ai_video_enabled",
  "curator_interview_enabled",
  "friends_vote_enabled",
]);

export async function setToggleAction(
  key: string,
  value: boolean,
): Promise<{ ok: true } | { error: string }> {
  const user = await requireOwner("whatsapp");
  try {
    const parsedKey = toggleKeySchema.parse(key);
    await updateSetting(getDb(), { key: parsedKey, value, userId: user.id });
    revalidatePath("/admin/whatsapp");
    revalidatePath("/admin/whatsapp/provador");
    if (parsedKey === "ai_photos_in_store") {
      // A vitrine tem ISR: a foto no corpo entra (ou sai) da loja na hora.
      revalidatePath("/");
      revalidatePath("/produtos");
      revalidatePath("/(store)/produto/[slug]", "page");
      revalidatePath("/(store)/belem/[slug]", "page");
    }
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
    const botMode = text("botMode") || "autonomous";
    await updateSetting(db, { key: "bot_mode", value: botMode, userId: user.id });
    if (botMode === "autonomous") await supersedeAllPendingSuggestions(db);
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
    const hours = (name: string): number => {
      const value = Number(text(name));
      return Number.isFinite(value) ? Math.trunc(value) : Number.NaN;
    };
    await updateSetting(db, {
      key: "handoff_silence_hours",
      value: hours("handoffSilenceHours"),
      userId: user.id,
    });
    await updateSetting(db, {
      key: "handoff_auto_return_hours",
      value: hours("handoffAutoReturnHours"),
      userId: user.id,
    });
    const idleCartHours = hours("idleCartFollowupHours");
    await updateSetting(db, {
      key: "bot_idle_cart_followup_hours",
      value: idleCartHours,
      userId: user.id,
    });
    // Desligou: o que já estava agendado para a abertura da janela cai junto.
    if (idleCartHours === 0) await cancelScheduledIdleCartFollowups(db, { reason: "desligado" });

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
    const turn = await rehearseBotTurn(getDb(), getSalesAssistant(), parsed, {
      cards: {
        storage: getFileStorage(),
        render: async (data) => renderCardPng(data, await loadReceiptAssets()),
      },
    });
    return { ok: true, turn };
  } catch (error) {
    if (error instanceof AssistantUnavailableError) {
      return { error: `A vendedora não respondeu: ${error.reason}. Tente de novo em instantes.` };
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

// ---------------------------------------------------------------------------
// "Bom dia da maison" — enviar agora (o resumo de ontem, fora do horário)
// ---------------------------------------------------------------------------

const DIGEST_SKIP_MESSAGES: Record<string, string> = {
  digest_desligado: "O resumo está desligado — ligue o interruptor acima.",
  desabilitado: "O WhatsApp da loja está desligado.",
  sem_telefone_dono: "Cadastre o seu WhatsApp na conexão abaixo antes de enviar.",
  sem_template: "O modelo “Bom dia da TRIVÉ” está desligado nas mensagens automáticas.",
  numero_sem_whatsapp: "O seu número não tem WhatsApp ativo — confira na conexão abaixo.",
};

export async function sendDigestNowAction(
  _prev: FormState,
  _formData: FormData,
): Promise<FormState> {
  await requireOwner("whatsapp");
  try {
    const date = yesterdaySpDayKey();
    const result = await sendDailyDigestWa(
      getDb(),
      getMessagingProvider(),
      getFileStorage(),
      async (data) => renderDailyDigestPng(data, await loadReceiptAssets()),
      { date, force: true },
    );
    revalidatePath("/admin/whatsapp");
    if ("sent" in result) {
      return { success: "Resumo de ontem enviado para o seu WhatsApp." };
    }
    return {
      error: `Não foi enviado. ${DIGEST_SKIP_MESSAGES[result.skipped] ?? result.skipped}`,
    };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

/** Inteiro dentro de [min, max]; vazio é erro (nunca vira 0 em silêncio). */
function parseGiftIntField(raw: string, label: string, min: number, max: number): number {
  const trimmed = raw.trim();
  const value = trimmed === "" ? Number.NaN : Number(trimmed);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ServiceError("numero_invalido", `${label}: informe um número inteiro entre ${min} e ${max}.`);
  }
  return value;
}

/** Gentilezas da Lia: a cota e as condições do cupom de bolso. */
export async function saveLiaGiftSettingsAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireOwner("whatsapp");
  try {
    const db = getDb();
    const text = (name: string) => String(formData.get(name) ?? "");
    let minCartCents: number;
    try {
      minCartCents = parseBRLToCents(text("minCart").trim() || "0");
      if (minCartCents < 0) throw new RangeError("negativo");
    } catch {
      throw new ServiceError("valor_invalido", "Sacola mínima (R$): informe um valor em reais, ex.: 150,00.");
    }
    const values: Array<{ key: string; value: unknown }> = [
      { key: "lia_gift_percent", value: parseGiftIntField(text("percent"), "Desconto (%)", 1, 50) },
      { key: "lia_gift_daily_quota", value: parseGiftIntField(text("dailyQuota"), "Gentilezas por dia", 0, 20) },
      { key: "lia_gift_min_purchases", value: parseGiftIntField(text("minPurchases"), "Compras anteriores", 0, 10) },
      { key: "lia_gift_min_cart_cents", value: minCartCents },
      { key: "lia_gift_days", value: parseGiftIntField(text("validDays"), "Vale por (dias)", 1, 30) },
      { key: "lia_gift_cooldown_days", value: parseGiftIntField(text("cooldownDays"), "Mesma cliente de novo só depois de (dias)", 0, 365) },
    ];
    for (const { key, value } of values) {
      await updateSetting(db, { key, value, userId: user.id });
    }
    revalidatePath("/admin/whatsapp");
    return { success: "Gentilezas salvas." };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

// ---------------------------------------------------------------------------
// Entrevista da curadora
// ---------------------------------------------------------------------------

const interviewScheduleSchema = z.object({
  hour: z.coerce.number().int().min(9, "A pergunta sai entre 9h e 20h.").max(20, "A pergunta sai entre 9h e 20h."),
  weekends: z.enum(["on", "off"]),
});

export async function saveInterviewScheduleAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireOwner("whatsapp");
  try {
    const parsed = interviewScheduleSchema.parse({ hour: formData.get("hour"), weekends: formData.get("weekends") });
    await saveInterviewSchedule(getDb(), { hour: parsed.hour, weekends: parsed.weekends === "on", userId: user.id });
    revalidatePath("/admin/whatsapp");
    return { success: "Horário da entrevista salvo." };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

export async function askInterviewNowAction(_prev: FormState, _formData: FormData): Promise<FormState> {
  const user = await requireOwner("whatsapp");
  try {
    const result = await requestCuratorInterviewNow(getDb(), { userId: user.id });
    revalidatePath("/admin/whatsapp");
    if (result.ok) return { success: "Pedido enviado: a pergunta chega no seu WhatsApp em instantes." };
    return {
      error:
        result.reason === "aberta"
          ? "Já tem uma pergunta esperando a sua resposta no WhatsApp — responda (ou mande “pula”) antes de pedir outra."
          : INTERVIEW_PROBLEM_TEXT[result.reason],
    };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}
