// Cartela de estilo, anotações e linhas extras do caderninho.
import { addNote } from "@/core/bot/memory";
import type { BotToolInputs } from "@/core/bot/tools";
import type { DbOrTx } from "@/queue/enqueue";
import { renderProfileNote } from "@/core/style/profile";
import { listOpenAlertsByPhone } from "@/services/stock-alerts";
import { getStyleProfileByPhone, saveStyleProfile } from "@/services/style-profiles";
import { getActiveHoldByPhone } from "@/services/stock-holds";

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
  const [note] = renderProfileNote(saved.profile, saved.paletteName);
  return { ok: true, text: `Cartela atualizada. ${note ?? ""}`.trim() };
}

/** Linhas do caderninho que moram em tabela própria (cartela, reserva, avisos). */
export async function loadMemoryLines(db: DbOrTx, phoneE164: string): Promise<string[]> {
  const [profile, hold, alerts] = await Promise.all([
    getStyleProfileByPhone(db, phoneE164),
    getActiveHoldByPhone(db, phoneE164),
    listOpenAlertsByPhone(db, phoneE164),
  ]);
  const lines: string[] = [];
  if (profile) lines.push(...renderProfileNote(profile.profile, profile.paletteName));
  if (hold) lines.push(`Reserva ativa (gentil): ${hold.description}`);
  if (alerts.length > 0) {
    lines.push(
      `Avisos pedidos (quando voltar): ${alerts
        .map((alert) => `${alert.productName}${alert.variantLabel ? ` (${alert.variantLabel})` : ""}`)
        .join(", ")}`,
    );
  }
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
  const state = await updateBotState(db, ctx, (current) => ({
    ...current,
    notes: addNote(current.notes, input.nota),
  }));
  return {
    ok: true,
    text: `Anotado. Caderninho: ${(state.notes ?? []).join("; ")}`,
  };
}
