// "Me vê com ela" — os portões DEPOIS da FASHN, antes de a prévia chegar à
// cliente. PURO: prompts, JSONs e a regra. São DOIS julgamentos focados (a
// calibração de 13/10 mostrou que um só, com as três imagens, deixava passar
// um decote quadrado que virou redondo):
// - a PEÇA: a foto real da peça × a prévia. Descreve decote, manga e
//   comprimento das duas ANTES do veredito (os campos saem nessa ordem);
// - a PESSOA: a foto original dela × a prévia. Rosto e corpo dela.
// Diferente do portão do estúdio (core/studio/fidelity.ts), que julga se a
// foto pode ir para o Instagram: aqui a foto é DELA — selfie no espelho,
// celular no rosto e luz de casa são normais e nunca reprovam.
import { z } from "zod";

export const TRYON_JUDGE_MIN_SCORE = 7;

const NOT_EDITORIAL = "NÃO reprove por nada que vem da foto original da cliente: selfie no espelho, celular na frente do rosto, luz de casa, fundo simples, foto amadora, enquadramento. A foto é dela e é assim mesmo.";

export const GARMENT_JUDGE_SYSTEM_PROMPT = `Você é a revisora das prévias da TRIVÉ, uma loja de moda feminina em Belém do Pará.
Uma cliente pediu para ver uma peça da loja no próprio corpo e a IA gerou a prévia. Você receberá DUAS imagens: 1) a foto real da PEÇA (esticada, em cabide ou vestida em outra pessoa); 2) a PRÉVIA (a cliente vestindo a peça).
Sua tarefa: dizer se a peça da prévia é FIEL à peça real. Responda SÓ o JSON pedido, preenchendo os campos na ordem.
${NOT_EDITORIAL}

Primeiro descreva, em poucas palavras, a peça REAL e depois a peça da PRÉVIA, sempre nesta ordem: tipo; cor; estampa ou detalhes (botões, fivela, babado, alças); decote (formato: quadrado, redondo, V, tomara que caia, gola…); manga; comprimento (onde termina no corpo).
Depois julgue:
- mesma_peca: é claramente a mesma peça (não uma parecida)?
- cor_ok: a cor é a mesma, com tolerância só para a luz do ambiente?
- estampa_ok: estampa e detalhes são os mesmos, sem nada inventado ou sumido?
- corte_ok: decote, manga e comprimento são os mesmos? Decote de formato diferente ou peça mais curta/longa é false.
- artefatos: defeitos que a cliente notaria (mãos ou dedos errados, tecido derretido, membros extras, texto ou logotipo inventado). Vazia quando não há.
- nota: de 0 a 10, o quanto a peça da prévia é a peça real.
Na dúvida, reprove: é melhor não mandar do que mostrar uma peça diferente da real. Estampa ou decote diferentes são sempre reprovação.`;

export const GARMENT_JUDGE_USER_TEXT = "Imagem 1: a peça real. Imagem 2: a prévia. Responda no JSON.";

export const GARMENT_JUDGE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    peca_real: { type: "string" },
    peca_na_previa: { type: "string" },
    mesma_peca: { type: "boolean" },
    cor_ok: { type: "boolean" },
    estampa_ok: { type: "boolean" },
    corte_ok: { type: "boolean" },
    artefatos: { type: "array", items: { type: "string" } },
    // A saída estruturada não aceita minimum/maximum em inteiro: 0–10 fica no prompt e no Zod.
    nota: { type: "integer", description: "De 0 a 10." },
  },
  required: ["peca_real", "peca_na_previa", "mesma_peca", "cor_ok", "estampa_ok", "corte_ok", "artefatos", "nota"],
  additionalProperties: false,
};

export const garmentJudgmentSchema = z.object({
  peca_real: z.string().max(600),
  peca_na_previa: z.string().max(600),
  mesma_peca: z.boolean(),
  cor_ok: z.boolean(),
  estampa_ok: z.boolean(),
  corte_ok: z.boolean(),
  artefatos: z.array(z.string().trim().min(1)).max(12),
  nota: z.number().int().min(0).max(10),
});

export type GarmentJudgment = z.infer<typeof garmentJudgmentSchema>;

export const PERSON_JUDGE_SYSTEM_PROMPT = `Você é a revisora das prévias da TRIVÉ, uma loja de moda feminina em Belém do Pará.
Uma cliente mandou uma foto dela e a IA gerou a prévia dela vestindo uma peça da loja. Você receberá DUAS imagens: 1) a foto ORIGINAL da cliente; 2) a PRÉVIA gerada.
Sua tarefa: dizer se a pessoa da prévia continua sendo ELA, com o corpo DELA. A roupa muda de propósito — não julgue a roupa. Responda SÓ o JSON pedido.
${NOT_EDITORIAL}

- mesma_pessoa: rosto, cabelo e tom de pele são os da cliente?
- diferencas_no_corpo: lista curta do que mudou nas proporções do corpo (ombros, braços, cintura, quadril, pernas), sem contar o que a roupa nova só cobre ou revela. Roupa solta esconde curvas e roupa justa as mostra: isso NÃO é diferença. Pernas ou pés completados onde a foto original cortava também não, se plausíveis. Vazia quando o corpo é o mesmo.
- corpo_preservado: false se a IA afinou, alongou, encorpou ou mudou o formato do corpo dela.
- artefatos: defeitos que ela notaria em si mesma (rosto deformado, mãos ou dedos errados, membros extras). Vazia quando não há.`;

export const PERSON_JUDGE_USER_TEXT = "Imagem 1: a foto original da cliente. Imagem 2: a prévia. Responda no JSON.";

export const PERSON_JUDGE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    mesma_pessoa: { type: "boolean" },
    diferencas_no_corpo: { type: "array", items: { type: "string" } },
    corpo_preservado: { type: "boolean" },
    artefatos: { type: "array", items: { type: "string" } },
  },
  required: ["mesma_pessoa", "diferencas_no_corpo", "corpo_preservado", "artefatos"],
  additionalProperties: false,
};

export const personJudgmentSchema = z.object({
  mesma_pessoa: z.boolean(),
  diferencas_no_corpo: z.array(z.string().trim().min(1)).max(12),
  corpo_preservado: z.boolean(),
  artefatos: z.array(z.string().trim().min(1)).max(12),
});

export type PersonJudgment = z.infer<typeof personJudgmentSchema>;

export type TryOnVerdict = { garment: GarmentJudgment; person: PersonJudgment };

/** A peça: os quatro "sim", nota no corte e nenhum defeito. */
export function passesGarmentJudge(judgment: GarmentJudgment, minScore = TRYON_JUDGE_MIN_SCORE): boolean {
  return (
    judgment.mesma_peca &&
    judgment.cor_ok &&
    judgment.estampa_ok &&
    judgment.corte_ok &&
    judgment.artefatos.length === 0 &&
    judgment.nota >= minScore
  );
}

/** A pessoa: ela mesma, o corpo dela e nenhum defeito. */
export function passesPersonJudge(judgment: PersonJudgment): boolean {
  return judgment.mesma_pessoa && judgment.corpo_preservado && judgment.artefatos.length === 0;
}

export function passesTryOnVerdict(verdict: TryOnVerdict): boolean {
  return passesGarmentJudge(verdict.garment) && passesPersonJudge(verdict.person);
}

/** Uma linha para o log e a auditoria: "8/10" ou "6/10 — decote diferente; corpo mudou (cintura afinada)". */
export function tryOnVerdictSummary(verdict: TryOnVerdict): string {
  const { garment, person } = verdict;
  const problems = [
    garment.mesma_peca ? null : "outra peça",
    garment.cor_ok ? null : "cor diferente",
    garment.estampa_ok ? null : "detalhes diferentes",
    garment.corte_ok ? null : "corte diferente",
    ...garment.artefatos,
    person.mesma_pessoa ? null : "pessoa diferente",
    person.corpo_preservado ? null : `corpo mudou${person.diferencas_no_corpo.length > 0 ? ` (${person.diferencas_no_corpo.join(", ")})` : ""}`,
    ...person.artefatos,
  ].filter((item): item is string => item !== null);
  return problems.length > 0 ? `${garment.nota}/10 — ${problems.join("; ")}` : `${garment.nota}/10`;
}
