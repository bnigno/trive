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
  proposal: Pick<ArrivalProposal, "colors" | "sizes" | "quantityPerVariant" | "totalQuantity" | "unitCostCents" | "totalCostCents" | "costBasis" | "supplierName"> | null,
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
  if (suggestedPriceCents !== null) parts.push(`sugerido ${formatCentsBRL(suggestedPriceCents)}`);
  if (proposal.supplierName) parts.push(proposal.supplierName);
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
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
