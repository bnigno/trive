// Cartela de estilo, anotações e linhas extras do caderninho.
import { addNote } from "@/core/bot/memory";
import type { BotToolInputs } from "@/core/bot/tools";
import type { DbOrTx } from "@/queue/enqueue";
import { renderProfileNote } from "@/core/style/profile";
import { listOpenAlertsByPhone } from "@/services/stock-alerts";
import { adviseSizeForProduct } from "@/services/fit-advice";
import { forgetBodyMeasurements, getStyleProfileByPhone, saveBodyMeasurements, saveStyleProfile } from "@/services/style-profiles";
import { resolveProductDetail } from "./catalog";
import { listFeedbackByPhone } from "@/services/delivery-feedback";
import { listLooksMemoryLines } from "@/services/customer-looks";
import { getActiveHoldByPhone } from "@/services/stock-holds";
import { groupMemoryLines } from "@/services/wa-groups";

import { DRY_RUN_TEXT, updateBotState } from "./shared";
import type { BotExecutorContext, ToolResult } from "./shared";

export async function execAtualizarCartela(
  db: DbOrTx,
  ctx: BotExecutorContext,
  input: BotToolInputs["atualizar_cartela"],
): Promise<ToolResult> {
  if (ctx.dryRun) return { ok: true, text: DRY_RUN_TEXT };
  const saved = await saveStyleProfile(db, {
    phoneE164: ctx.phoneE164,
    customerId: ctx.customerId,
    source: "lia",
    patch: {
      ...(input.tamanhos ? { sizes: input.tamanhos } : {}),
      ...(input.cores_ama ? { colorsLove: input.cores_ama } : {}),
      ...(input.cores_evita ? { colorsAvoid: input.cores_evita } : {}),
      ...(input.caimento ? { fit: input.caimento } : {}),
      ...(input.ocasioes ? { occasions: input.ocasioes } : {}),
      ...(input.compra_para ? { buysFor: input.compra_para } : {}),
    },
  });
  // As medidas vão para a coluna própria (nunca no perfil nem no histórico).
  let bodyNote = "";
  if (input.medidas?.apagar) {
    const { forgotten } = await forgetBodyMeasurements(db, { phoneE164: ctx.phoneE164 });
    bodyNote = forgotten ? " Medidas apagadas — confirme em 1 frase." : " Não havia medidas guardadas.";
  } else if (input.medidas) {
    const body = {
      ...(input.medidas.busto_cm !== undefined ? { bustCm: input.medidas.busto_cm } : {}),
      ...(input.medidas.cintura_cm !== undefined ? { waistCm: input.medidas.cintura_cm } : {}),
      ...(input.medidas.quadril_cm !== undefined ? { hipsCm: input.medidas.quadril_cm } : {}),
    };
    if (Object.keys(body).length > 0) {
      const { saved: savedBody } = await saveBodyMeasurements(db, { phoneE164: ctx.phoneE164, body });
      bodyNote = savedBody ? " Medidas guardadas — já pode chamar sugerir_tamanho; não repita os números para ela." : "";
    }
  }
  const [note] = renderProfileNote(saved.profile, saved.paletteName, { hasBody: saved.hasBodyMeasurements || bodyNote !== "" });
  return { ok: true, text: `Cartela atualizada. ${note ?? ""}${bodyNote}`.trim() };
}

/**
 * "O M me serve?": as medidas da cartela contra a tabela da peça. Só leitura
 * (roda no ensaio também); sem medidas, orienta a pedir e guardar.
 */
export async function execSugerirTamanho(
  db: DbOrTx,
  ctx: BotExecutorContext,
  input: BotToolInputs["sugerir_tamanho"],
): Promise<ToolResult> {
  const resolved = await resolveProductDetail(db, input.produto, { customerId: ctx.customerId });
  if (resolved.kind !== "found") {
    return {
      ok: false,
      text:
        resolved.kind === "ambiguous"
          ? `Mais de uma peça com esse nome (${resolved.candidates.map((c) => c.name).join(", ")}): passe o slug exato.`
          : `Não achei a peça "${input.produto}". Confira com detalhar_produto ou listar_produtos.`,
    };
  }
  const view = await adviseSizeForProduct(db, { slug: resolved.detail.slug, phoneE164: ctx.phoneE164 });
  if (view.advice.kind === "no_body") {
    return {
      ok: false,
      text: "Ela ainda não tem medidas na cartela. Pergunte busto, cintura e quadril em centímetros (contorno), guarde com atualizar_cartela.medidas e chame sugerir_tamanho de novo. Nunca estime pela foto.",
    };
  }
  if (view.advice.kind !== "advice") return { ok: false, text: view.text };
  return {
    ok: true,
    text: `${resolved.detail.name}: ${view.text} Fale em folga (centímetros que sobram) e no tamanho recomendado — nunca repita as medidas do corpo dela.`,
  };
}

/** Linhas do caderninho que moram em tabela própria (cartela, reserva, avisos). */
export async function loadMemoryLines(db: DbOrTx, phoneE164: string): Promise<string[]> {
  const [profile, hold, alerts, feedback, looks, provador] = await Promise.all([
    getStyleProfileByPhone(db, phoneE164),
    getActiveHoldByPhone(db, phoneE164),
    listOpenAlertsByPhone(db, phoneE164),
    listFeedbackByPhone(db, phoneE164),
    listLooksMemoryLines(db, phoneE164),
    groupMemoryLines(db, phoneE164),
  ]);
  const lines: string[] = [];
  if (profile) lines.push(...renderProfileNote(profile.profile, profile.paletteName, { hasBody: profile.hasBodyMeasurements }));
  if (hold) lines.push(`Reserva ativa (gentil): ${hold.description}`);
  if (alerts.length > 0) {
    lines.push(
      `Avisos pedidos (quando voltar): ${alerts
        .map((alert) => `${alert.productName}${alert.variantLabel ? ` (${alert.variantLabel})` : ""}`)
        .join(", ")}`,
    );
  }
  lines.push(...feedback, ...looks, ...provador);
  return lines;
}

export async function execAnotar(
  db: DbOrTx,
  ctx: BotExecutorContext,
  input: BotToolInputs["anotar"],
): Promise<ToolResult> {
  // Guarda de privacidade: nada que pareça CPF, cartão ou CEP vai para o
  // caderninho, por mais que o modelo insista.
  if (/\d{3}\.?\d{3}\.?\d{3}-?\d{2}|\d{4}\s?\d{4}\s?\d{4}\s?\d{4}|\d{5}-?\d{3}/.test(input.nota)) {
    return {
      ok: false,
      text: "Não anoto documentos, cartões nem endereços — só preferências (tamanho, cores, ocasião, para quem compra).",
    };
  }
  // Medidas do corpo não são anotação: vão para atualizar_cartela.medidas (coluna própria, fora do histórico).
  if (/\b(busto|cintura|quadril|medidas?)\b[^\d]{0,20}\d{2,3}\b|\b\d{2,3}\s*(cm)?\s*(de|do|da|no|na)?\s*(busto|cintura|quadril)\b|\b\d{2,3}\s*[\/x-]\s*\d{2,3}\s*[\/x-]\s*\d{2,3}\b/i.test(input.nota)) {
    return { ok: false, text: "Medidas do corpo não vão para o caderninho: guarde com atualizar_cartela.medidas (busto_cm, cintura_cm, quadril_cm)." };
  }
  const state = await updateBotState(db, ctx, (current) => ({
    ...current,
    notes: addNote(current.notes, input.nota),
  }));
  return {
    ok: true,
    text: `Anotado. Caderninho: ${(state.notes ?? []).join("; ")}`,
  };
}
