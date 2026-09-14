// O que a dona lê de volta — PURO. As variáveis do template
// owner_atelier_draft ("Rascunho pronto · Longo Dunas · 3 fotos · 2 cores ×
// 4 tamanhos · 3 de cada · custo R$ 120,00 · sugerido R$ 289,90") e os
// motivos do owner_atelier_help (quando o envio não deu para cadastrar).
import { formatCentsBRL } from "@/lib/money";

import type { ArrivalProposal } from "./proposal";

export function photosLabel(count: number): string {
  return count === 1 ? "1 foto" : `${count} fotos`;
}

export type AtelierDraftVars = { peca: string; fotos: string; link: string; detalhes: string };

export function atelierDraftVars(input: { name: string; photos: number; link: string; details?: string }): AtelierDraftVars {
  return { peca: input.name, fotos: photosLabel(input.photos), link: input.link, detalhes: input.details ?? "" };
}

/**
 * A linha de detalhes da chegada, só com o que se sabe: " · 2 cores × 4
 * tamanhos · 3 de cada · custo R$ 120,00 · sugerido R$ 289,90". Começa com
 * o separador para colar em "{{fotos}}{{detalhes}}"; vazia sem proposta.
 */
export function arrivalDetailsLine(
  proposal: Pick<ArrivalProposal, "colors" | "sizes" | "quantityPerVariant" | "totalQuantity" | "unitCostCents" | "totalCostCents" | "unconfirmedCostCents" | "costBasis" | "supplierName"> | null,
  suggestedPriceCents: number | null,
): string {
  if (!proposal) return "";
  const parts: string[] = [];
  const grid: string[] = [];
  if (proposal.colors.length > 0) grid.push(proposal.colors.length === 1 ? "1 cor" : `${proposal.colors.length} cores`);
  if (proposal.sizes.length > 0) grid.push(proposal.sizes.length === 1 ? "1 tamanho" : `${proposal.sizes.length} tamanhos`);
  if (grid.length > 0) parts.push(grid.join(" × "));
  if (proposal.quantityPerVariant !== null) {
    parts.push(`${proposal.quantityPerVariant} de cada${proposal.totalQuantity !== null ? ` (${proposal.totalQuantity} peças)` : ""}`);
  } else if (proposal.totalQuantity !== null) {
    parts.push(`${proposal.totalQuantity} peças`);
  }
  if (proposal.unitCostCents !== null) parts.push(`custo ${formatCentsBRL(proposal.unitCostCents)}`);
  else if (proposal.totalCostCents !== null) parts.push(`custo total ${formatCentsBRL(proposal.totalCostCents)}`);
  else if (proposal.unconfirmedCostCents !== null) parts.push(`custo ${formatCentsBRL(proposal.unconfirmedCostCents)} (por peça ou o lote? confira)`);
  if (suggestedPriceCents !== null) parts.push(`sugerido ${formatCentsBRL(suggestedPriceCents)}`);
  if (proposal.supplierName) parts.push(proposal.supplierName);
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

/** Variáveis do template owner_atelier_nudge ("Recebi 2 fotos 📸 …"). */
export function atelierNudgeVars(photos: number): { fotos: string } {
  return { fotos: photosLabel(photos) };
}

export const ATELIER_HELP_REASONS = {
  sem_fotos: "Não achei fotos suas dos últimos 15 minutos — mande as fotos e repita o recado.",
  documento: "Essa veio como documento: mande pela galeria, como foto.",
  audio_sem_transcricao: "Não consigo ouvir áudio por aqui agora — mande o recado por texto.",
  fotos_indisponiveis: "As fotos já não estão mais disponíveis no WhatsApp — mande de novo, por favor.",
  erro: "Deu erro ao montar o rascunho; cadastre pelo painel ou mande de novo mais tarde.",
} as const;

export type AtelierHelpReason = keyof typeof ATELIER_HELP_REASONS;

export function atelierHelpReasonText(reason: AtelierHelpReason): string {
  return ATELIER_HELP_REASONS[reason];
}

export function isAtelierHelpReason(value: unknown): value is AtelierHelpReason {
  return typeof value === "string" && value in ATELIER_HELP_REASONS;
}

/** Por que a inteligência não montou a grade — em português, para o painel. */
export const INTERPRETATION_FAILED_LABELS: Record<string, string> = {
  ia_indisponivel: "a inteligência está sem chave ou sem crédito",
  ia_demorou: "a inteligência demorou demais",
  ia_erro: "erro ao chamar a inteligência",
  json_invalido: "a resposta veio fora do formato",
  sem_tempo: "não sobrou tempo na fila para a inteligência",
  ficha_recusou: "a ficha recusou a grade proposta",
  sem_interpretacao: "a peça já existia antes da leitura",
};

export function interpretationFailedLabel(code: string): string {
  return INTERPRETATION_FAILED_LABELS[code] ?? code;
}

/** O que ficou anotado na chegada (código do C-A ou texto livre) — em português. */
export function errorDetailLabel(detail: string): string {
  return isAtelierHelpReason(detail) ? ATELIER_HELP_REASONS[detail] : detail;
}
