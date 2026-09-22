// Portão de fidelidade: antes de a dona ver, a visão que já existe compara a
// foto real da peça com a gerada e devolve um JSON fixo. Abaixo do corte,
// descarta e tenta de novo — com teto. PURO: o prompt, o schema e a regra.
import { z } from "zod";

export const FIDELITY_MIN_SCORE = 7;
/** Tentativas por opção (a primeira + uma repetição com outra semente). */
export const MAX_ATTEMPTS_PER_OPTION = 2;

export const FIDELITY_SYSTEM_PROMPT = `Você é a revisora de fotos da TRIVÉ, uma loja de moda feminina em Belém do Pará.
Você receberá DUAS imagens. A PRIMEIRA é a foto real da peça (esticada, em cabide ou no manequim). A SEGUNDA é uma foto gerada por computador com a mesma peça no corpo de uma modelo.
Sua única tarefa é julgar se a segunda foto é fiel à peça da primeira e se pode ir para o Instagram como se fosse uma foto real. Responda SÓ o JSON pedido.

Critérios:
- mesma_peca: é claramente a mesma peça (não uma parecida)?
- cor_ok: a cor é a mesma, com tolerância só para a luz do ambiente?
- estampa_ok: estampa, desenho, botões, babados, alças, decote e detalhes são os mesmos, sem elementos inventados ou sumidos?
- corte_ok: comprimento, manga, modelagem e caimento são os da peça real?
- artefatos: lista curta de defeitos que uma cliente notaria (mãos ou dedos errados, tecido derretido, texto ou logotipo, membros extras, rosto estranho, pele de plástico). Vazia quando não há.
- nota: de 0 a 10, quanto esta foto pode ir para o feed como foto real da peça.

Seja rigorosa: na dúvida, reprove. Estampa diferente é sempre reprovação, mesmo bonita.`;

export const FIDELITY_USER_TEXT = "Compare a foto 1 (peça real) com a foto 2 (gerada) e responda no JSON.";

export const FIDELITY_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    mesma_peca: { type: "boolean" },
    cor_ok: { type: "boolean" },
    estampa_ok: { type: "boolean" },
    corte_ok: { type: "boolean" },
    artefatos: { type: "array", items: { type: "string" } },
    // A API de saída estruturada não aceita minimum/maximum em inteiro: o
    // intervalo 0–10 fica no prompt e no Zod (fidelityJudgmentSchema).
    nota: { type: "integer", description: "De 0 a 10." },
  },
  required: ["mesma_peca", "cor_ok", "estampa_ok", "corte_ok", "artefatos", "nota"],
  additionalProperties: false,
};

export const fidelityJudgmentSchema = z.object({
  mesma_peca: z.boolean(),
  cor_ok: z.boolean(),
  estampa_ok: z.boolean(),
  corte_ok: z.boolean(),
  artefatos: z.array(z.string().trim().min(1)).max(12),
  nota: z.number().int().min(0).max(10),
});

export type FidelityJudgment = z.infer<typeof fidelityJudgmentSchema>;

/** Passa só com os quatro "sim", nota no corte e nenhum defeito listado. */
export function passesFidelity(judgment: FidelityJudgment, minScore = FIDELITY_MIN_SCORE): boolean {
  return (
    judgment.mesma_peca &&
    judgment.cor_ok &&
    judgment.estampa_ok &&
    judgment.corte_ok &&
    judgment.artefatos.length === 0 &&
    judgment.nota >= minScore
  );
}

/** Uma linha para o painel e para o WhatsApp da dona: "8/10" ou "reprovada: cor, estampa". */
export function fidelitySummary(judgment: FidelityJudgment): string {
  const problems: string[] = [];
  if (!judgment.mesma_peca) problems.push("outra peça");
  if (!judgment.cor_ok) problems.push("cor");
  if (!judgment.estampa_ok) problems.push("estampa");
  if (!judgment.corte_ok) problems.push("corte");
  problems.push(...judgment.artefatos);
  if (passesFidelity(judgment)) return `${judgment.nota}/10`;
  return problems.length > 0 ? `${judgment.nota}/10 — ${problems.join(", ")}` : `${judgment.nota}/10 — abaixo do corte`;
}

/** Há mais uma tentativa depois desta? (attempt começa em 0.) */
export function canRetryAttempt(attempt: number, maxAttempts = MAX_ATTEMPTS_PER_OPTION): boolean {
  return attempt + 1 < maxAttempts;
}
