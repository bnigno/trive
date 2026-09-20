// Reconhecer a peça do catálogo numa foto que a cliente mandou — PURO.
// Duas camadas: (1) a impressão digital da foto (dHash, core/images/phash.ts)
// comparada com a das fotos do catálogo — barata, sem modelo; (2) quando a
// primeira não bate, a inteligência compara a foto com até 8 candidatas. Os
// limiares vivem aqui, num lugar só; os textos que a ferramenta devolve ao
// modelo também. Calibrado com as fotos reais da loja em 2026-09-20: a mesma
// foto reencodada/menor fica a ≤ 3 bits, com texto por cima chegou a 6;
// fotos de produtos DIFERENTES nunca ficaram abaixo de 11.
import { z } from "zod";

import { hammingDistance, hexToPhash } from "@/core/images/phash";

/** Até aqui é a MESMA foto (reencodada, menor, com sticker/texto por cima). */
export const PHOTO_MATCH_MAX_DISTANCE = 8;
/** De 9 a 10 bits: quase igual — a Lia confirma com a cliente antes de afirmar. */
export const PHOTO_MATCH_MAYBE_DISTANCE = 10;
/** Candidatas que vão para a comparação visual (cada uma é uma miniatura de 400 px). */
export const PHOTO_MATCH_MAX_CANDIDATES = 8;
/** Comparação visual: a partir daqui é "provavelmente"; entre MAYBE e isto, "talvez". */
export const PHOTO_MATCH_CONFIDENT = 0.75;
export const PHOTO_MATCH_MAYBE = 0.5;
/**
 * Teto da comparação visual dentro do turno (miniaturas incluídas; o turno
 * inteiro tem 35 s), o mínimo que precisa sobrar para o modelo valer a pena
 * e a reserva que SEMPRE fica para a Lia escrever a resposta final depois.
 */
export const PHOTO_MATCH_BUDGET_MS = 12_000;
export const PHOTO_MATCH_MIN_BUDGET_MS = 5_000;
export const PHOTO_MATCH_REPLY_RESERVE_MS = 12_000;
/** Cada miniatura de candidata tem este teto para baixar; a que não vier só sai da lista. */
export const PHOTO_MATCH_THUMB_TIMEOUT_MS = 3_000;

/** Uma foto do catálogo com impressão digital, já com a peça (pública) a que pertence. */
export interface IndexedPhoto {
  phash: string;
  slug: string;
  name: string;
  color: string | null;
}

export type PhotoMatchTier = "exact" | "maybe";

export interface PhotoMatch {
  slug: string;
  name: string;
  /** A menor distância entre a foto da cliente e as fotos desta peça. */
  distance: number;
  /** As cores das fotos que bateram (sem repetir, na ordem em que apareceram). */
  colors: string[];
  tier: PhotoMatchTier;
}

/**
 * Agrupa por peça, fica com a menor distância de cada uma e devolve só o que
 * está dentro do limiar, da mais parecida para a menos. Uma foto usada em
 * duas peças públicas (erro de catálogo) aparece duas vezes — a Lia pergunta.
 */
export function rankPhotoMatches(hash: bigint, photos: readonly IndexedPhoto[]): PhotoMatch[] {
  const bySlug = new Map<string, PhotoMatch>();
  for (const photo of photos) {
    const stored = hexToPhash(photo.phash);
    if (stored === null) continue;
    const distance = hammingDistance(hash, stored);
    if (distance > PHOTO_MATCH_MAYBE_DISTANCE) continue;
    const tier: PhotoMatchTier = distance <= PHOTO_MATCH_MAX_DISTANCE ? "exact" : "maybe";
    const current = bySlug.get(photo.slug);
    if (!current) {
      bySlug.set(photo.slug, { slug: photo.slug, name: photo.name, distance, colors: photo.color ? [photo.color] : [], tier });
      continue;
    }
    if (photo.color && !current.colors.includes(photo.color)) current.colors.push(photo.color);
    if (distance < current.distance) {
      current.distance = distance;
      current.tier = tier;
    }
  }
  return [...bySlug.values()].sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Camada 2: a inteligência compara a foto com as candidatas.
// ---------------------------------------------------------------------------

/** A resposta estruturada da comparação visual (validada antes de usar). */
export const visionMatchesSchema = z.object({
  matches: z.array(
    z.object({
      slug: z.string(),
      confidence: z.number().min(0).max(1),
      color: z.string().nullable().optional(),
    }),
  ),
});

/** JSON Schema para a saída estruturada: uma LISTA (saída estruturada não aceita mapa de chaves livres), sem $ref. */
export const PHOTO_MATCH_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    matches: {
      type: "array",
      description: "As peças do catálogo que APARECEM na imagem 1 — a mesma peça, não uma parecida. Lista vazia quando nenhuma é a mesma.",
      items: {
        type: "object",
        properties: {
          slug: { type: "string", description: "O rótulo (slug) da candidata, exatamente como veio na lista." },
          confidence: { type: "number", description: "De 0 a 1: quanta certeza de que é a MESMA peça (mesmo modelo, mesma estampa/detalhes)." },
          color: { type: ["string", "null"], description: "A cor em que a peça aparece na imagem 1, se der para dizer; senão null." },
        },
        required: ["slug", "confidence", "color"],
        additionalProperties: false,
      },
    },
  },
  required: ["matches"],
  additionalProperties: false,
};

export interface VisionCandidate {
  slug: string;
  name: string;
}

export interface VisionMatch {
  slug: string;
  name: string;
  confidence: number;
  color: string | null;
}

export interface VisionTiers {
  provaveis: VisionMatch[];
  talvez: VisionMatch[];
}

/**
 * Separa a resposta do modelo em "provavelmente" (≥ 0,75) e "talvez" (0,5 a
 * 0,75); slug que não estava entre as candidatas é ignorado (o modelo não pode
 * inventar peça). Null quando a resposta não veio no formato.
 */
export function tierVisionMatches(raw: unknown, candidates: readonly VisionCandidate[]): VisionTiers | null {
  const parsed = visionMatchesSchema.safeParse(raw);
  if (!parsed.success) return null;
  const nameBySlug = new Map(candidates.map((candidate) => [candidate.slug, candidate.name]));
  const seen = new Set<string>();
  const tiers: VisionTiers = { provaveis: [], talvez: [] };
  for (const match of [...parsed.data.matches].sort((a, b) => b.confidence - a.confidence)) {
    const name = nameBySlug.get(match.slug);
    if (!name || seen.has(match.slug) || match.confidence < PHOTO_MATCH_MAYBE) continue;
    seen.add(match.slug);
    const entry: VisionMatch = { slug: match.slug, name, confidence: match.confidence, color: match.color ?? null };
    (match.confidence >= PHOTO_MATCH_CONFIDENT ? tiers.provaveis : tiers.talvez).push(entry);
  }
  return tiers;
}

export function photoMatchSystemPrompt(): string {
  return [
    "Você compara fotos de roupas para uma loja. A imagem 1 é a foto que a cliente mandou; as imagens seguintes são peças do catálogo, uma por imagem, na ordem dos rótulos da mensagem.",
    "Diga quais peças do catálogo APARECEM na imagem 1 — a MESMA peça (mesmo modelo, mesma estampa, mesmos detalhes), não uma parecida. Cor diferente da mesma peça ainda é a mesma peça.",
    "Se nenhuma candidata for a mesma peça, devolva a lista vazia. Nunca invente um rótulo que não está na lista. Não descreva pessoas.",
  ].join(" ");
}

/** A legenda das imagens que vão junto: "Imagem 2: blusa-maelle — Blusa Maelle". */
export function photoMatchUserText(candidates: readonly VisionCandidate[]): string {
  const lines = ["Imagem 1: a foto da cliente."];
  candidates.forEach((candidate, index) => {
    lines.push(`Imagem ${index + 2}: ${candidate.slug} — ${candidate.name}`);
  });
  lines.push("Quais desses rótulos aparecem na imagem 1?");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// O texto que a ferramenta devolve ao modelo.
// ---------------------------------------------------------------------------

export type VisionSkipReason = "sem_tempo" | "sem_bytes" | "sem_hash" | "sem_deps" | "falhou";

export interface PhotoMatchOutcome {
  /** Camada 1 (hash): a mesma foto. */
  exact: PhotoMatch[];
  /** Camada 1 (hash): quase a mesma (9–10 bits). */
  maybe: PhotoMatch[];
  /** Camada 2 (visão). */
  provaveis: VisionMatch[];
  talvez: VisionMatch[];
  /** Por que a camada 2 não rodou (null = rodou ou não foi preciso). */
  visionSkipped: VisionSkipReason | null;
}

const EXACT_MARK = "[reconhecimento exato]";
const LIKELY_MARK = "[reconhecimento provável]";

function describePiece(piece: { slug: string; name: string; colors?: string[]; color?: string | null }): string {
  const colors = piece.colors && piece.colors.length > 0 ? `; fotos nas cores ${piece.colors.join(", ")}` : piece.color ? `; na cor ${piece.color}` : "";
  return `${piece.name} (slug ${piece.slug}${colors})`;
}

const DETAIL_HINT = "Chame detalhar_produto com o slug para responder tamanho, cor, preço e estoque — não invente nada a partir da foto.";

/** O bloco pt-BR para o modelo; `ok: false` quando nada foi reconhecido (o modelo segue o fluxo de fotos parecidas). */
export function describePhotoMatches(outcome: PhotoMatchOutcome): { ok: boolean; text: string } {
  if (outcome.exact.length === 1) {
    return { ok: true, text: `Reconheci na foto: ${describePiece(outcome.exact[0])}. ${DETAIL_HINT} ${EXACT_MARK}` };
  }
  if (outcome.exact.length > 1) {
    return {
      ok: true,
      text: `Reconheci mais de uma peça na foto: ${outcome.exact.map(describePiece).join("; ")}. Pergunte qual ela quis dizer, citando os nomes — e depois detalhar_produto pelo slug. ${EXACT_MARK}`,
    };
  }
  if (outcome.provaveis.length > 0) {
    const list = outcome.provaveis.map(describePiece).join("; ");
    return {
      ok: true,
      text: `Provavelmente é ${list} — comparação visual, não a foto idêntica. Confirme em meia frase ("é a ${outcome.provaveis[0].name}?") e, com o sim, ${DETAIL_HINT.charAt(0).toLowerCase()}${DETAIL_HINT.slice(1)} ${LIKELY_MARK}`,
    };
  }
  const maybe = [...outcome.maybe.map(describePiece), ...outcome.talvez.map(describePiece)];
  if (maybe.length > 0) {
    return {
      ok: true,
      text: `Talvez seja ${maybe.join("; ")} — a foto não é idêntica à do catálogo. Confirme com a cliente em 1 pergunta antes de detalhar; se ela disser que sim, ${DETAIL_HINT.charAt(0).toLowerCase()}${DETAIL_HINT.slice(1)} ${LIKELY_MARK}`,
    };
  }
  const why =
    outcome.visionSkipped === "sem_tempo"
      ? " [sem tempo para a comparação visual neste turno]"
      : outcome.visionSkipped === "sem_bytes"
        ? " [foto de um turno anterior: só a comparação exata foi possível]"
        : outcome.visionSkipped === "sem_hash"
          ? " [foto anterior ao reconhecimento, sem impressão digital: se ela quiser que você confira, peça para reenviar]"
          : outcome.visionSkipped === "falhou"
            ? " [a comparação visual falhou agora]"
            : "";
  return {
    ok: false,
    text: `Não reconheci nenhuma peça do catálogo nessa foto: diga o que viu e busque parecidas com listar_produtos (categoria + cor).${why}`,
  };
}

// ---------------------------------------------------------------------------
// O que fica gravado em media_meta.reconhecido (e como a Central o lê).
// ---------------------------------------------------------------------------

/** exato = a mesma foto; provavel = a visão teve ≥ 0,75; talvez = a Lia ainda vai confirmar com a cliente. */
export type RecognitionLevel = "exato" | "provavel" | "talvez";

export interface Recognition {
  slugs: string[];
  nomes: string[];
  camada: "hash" | "visao";
  nivel: RecognitionLevel;
  distancia?: number;
  confianca?: number;
}

/**
 * O registro segue a MESMA precedência do texto devolvido ao modelo: exato
 * (hash) > provável (visão) > talvez (hash 9–10 e visão 0,5–0,75, juntos, na
 * ordem em que a Lia os ouviu). Null quando nada foi reconhecido.
 */
export function recognitionOf(outcome: PhotoMatchOutcome): Recognition | null {
  const pieces = (list: readonly { slug: string; name: string }[]) => ({ slugs: list.map((piece) => piece.slug), nomes: list.map((piece) => piece.name) });
  if (outcome.exact.length > 0) {
    return { ...pieces(outcome.exact), camada: "hash", nivel: "exato", distancia: outcome.exact[0].distance };
  }
  if (outcome.provaveis.length > 0) {
    return { ...pieces(outcome.provaveis), camada: "visao", nivel: "provavel", confianca: outcome.provaveis[0].confidence };
  }
  const talvez = [...outcome.maybe, ...outcome.talvez];
  if (talvez.length === 0) return null;
  return outcome.maybe.length > 0
    ? { ...pieces(talvez), camada: "hash", nivel: "talvez", distancia: outcome.maybe[0].distance }
    : { ...pieces(talvez), camada: "visao", nivel: "talvez", confianca: outcome.talvez[0].confidence };
}

/** O nível de um registro, inclusive dos gravados antes de existir `nivel` (deduzido de camada + distância/confiança). */
export function recognitionLevel(
  recognized: { nivel?: RecognitionLevel; camada: "hash" | "visao"; distancia?: number; confianca?: number } | null | undefined,
): RecognitionLevel | null {
  if (!recognized) return null;
  if (recognized.nivel) return recognized.nivel;
  if (recognized.camada === "hash") {
    return recognized.distancia !== undefined && recognized.distancia <= PHOTO_MATCH_MAX_DISTANCE ? "exato" : "talvez";
  }
  return recognized.confianca !== undefined && recognized.confianca >= PHOTO_MATCH_CONFIDENT ? "provavel" : "talvez";
}
