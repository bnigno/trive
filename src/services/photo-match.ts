// Reconhecer a peça do catálogo na foto da cliente: o índice de impressões
// digitais (product_images.phash, só peças públicas) e a comparação visual
// com candidatas (a inteligência olha a foto dela ao lado de miniaturas do
// catálogo). Regras e textos em core/bot/photo-match.ts; quem chama é a
// ferramenta identificar_peca_na_foto (services/bot/photo-match.ts).
import { and, eq, isNotNull, isNull } from "drizzle-orm";

import { AssistantUnavailableError, type BotImageInput, type SalesAssistant } from "@/adapters/assistant";
import type { FileStorage } from "@/adapters/storage";
import {
  PHOTO_MATCH_JSON_SCHEMA,
  PHOTO_MATCH_MAX_CANDIDATES,
  photoMatchSystemPrompt,
  photoMatchUserText,
  rankPhotoMatches,
  tierVisionMatches,
  type IndexedPhoto,
  type PhotoMatch,
  type VisionCandidate,
  type VisionTiers,
} from "@/core/bot/photo-match";
import { hexToPhash } from "@/core/images/phash";
import { productImages, products, settings } from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { resolveCategorySlug } from "@/services/bot/catalog";
import { DEFAULT_BOT_MODEL } from "@/services/bot/shared";
import { thumbPathFor } from "@/services/catalog";
import { getSettingsMap, type ServiceDb } from "@/services/settings";
import { listProductIdsWithVariant, listPublicProducts } from "@/services/store-catalog";

/** Setting bot_photo_match_enabled: ausente = ligado (só age quando a Lia vê fotos). */
export async function isBotPhotoMatchEnabled(db: DbOrTx): Promise<boolean> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "bot_photo_match_enabled"))
    .limit(1);
  return row?.value !== false;
}

/**
 * As fotos com impressão digital das peças PÚBLICAS (ativas, não apagadas).
 * Varredura em memória: são centenas de fotos hoje e vale até alguns
 * milhares; o índice do banco em phash serve só para igualdade exata.
 */
export async function listIndexedPhotos(db: DbOrTx): Promise<IndexedPhoto[]> {
  const rows = await db
    .select({ phash: productImages.phash, slug: products.slug, name: products.name, color: productImages.color })
    .from(productImages)
    .innerJoin(products, eq(products.id, productImages.productId))
    .where(and(isNotNull(productImages.phash), eq(products.status, "active"), isNull(products.deletedAt)))
    .orderBy(products.slug, productImages.sortOrder);
  return rows.flatMap((row) => (row.phash ? [{ phash: row.phash, slug: row.slug, name: row.name, color: row.color }] : []));
}

/** Camada 1: as peças cuja foto é (quase) a mesma da cliente. */
export async function findProductsByPhotoHash(db: DbOrTx, phashHex: string): Promise<PhotoMatch[]> {
  const hash = hexToPhash(phashHex);
  if (hash === null) return [];
  return rankPhotoMatches(hash, await listIndexedPhotos(db));
}

export interface VisionMatchInput {
  /** A foto da cliente, já preparada para o modelo. */
  image: BotImageInput;
  /** O que a Lia viu na foto: afunila as candidatas. */
  filters: { categoria?: string; cor?: string; busca?: string };
  customerId: string | null;
  /** Quanto tempo a comparação pode levar (quem chama já descontou o resto do turno). */
  budgetMs: number;
}

export interface VisionMatchResult extends VisionTiers {
  /** Por que não houve resposta útil (null = a comparação rodou). */
  failed: "sem_candidatas" | "ia_indisponivel" | "ia_demorou" | "json_invalido" | "ia_erro" | null;
  candidates: number;
}

/**
 * Camada 2: até 8 candidatas do catálogo (pelos filtros da Lia; sem nada, as
 * primeiras do catálogo), a miniatura de cada uma ao lado da foto da cliente,
 * e a inteligência diz quais APARECEM nela. Nunca lança: qualquer falha vira
 * `failed`, e a ferramenta segue com "não reconheci".
 */
export async function matchPhotoWithVision(
  db: DbOrTx,
  deps: { assistant: SalesAssistant; storage: FileStorage },
  input: VisionMatchInput,
): Promise<VisionMatchResult> {
  const empty: VisionTiers = { provaveis: [], talvez: [] };
  const candidates = await pickCandidates(db, input);
  if (candidates.length === 0) return { ...empty, failed: "sem_candidatas", candidates: 0 };

  // Miniaturas (400 px, webp) em paralelo; a que não abrir só sai da lista.
  const thumbs = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const file = await deps.storage.download(thumbPathFor(candidate.imagePath));
        return { candidate, image: { mediaType: "image/webp" as const, base64: Buffer.from(file.data).toString("base64") } };
      } catch (error) {
        console.warn(`[photo-match] miniatura indisponível (${candidate.slug}):`, error instanceof Error ? error.message : error);
        return null;
      }
    }),
  );
  const withThumb = thumbs.flatMap((entry) => (entry ? [entry] : []));
  if (withThumb.length === 0) return { ...empty, failed: "sem_candidatas", candidates: 0 };
  const labels: VisionCandidate[] = withThumb.map(({ candidate }) => ({ slug: candidate.slug, name: candidate.name }));

  const settingsMap = await getSettingsMap(db as unknown as ServiceDb, ["bot_model"]);
  const model = typeof settingsMap.bot_model === "string" && settingsMap.bot_model.trim() !== "" ? settingsMap.bot_model.trim() : DEFAULT_BOT_MODEL;

  const controller = new AbortController();
  let extraction;
  try {
    extraction = await withTimeout(
      deps.assistant.extractFromPhotos({
        system: photoMatchSystemPrompt(),
        images: [input.image, ...withThumb.map((entry) => entry.image)],
        userText: photoMatchUserText(labels),
        model,
        jsonSchema: PHOTO_MATCH_JSON_SCHEMA,
        maxTokens: 512,
        signal: controller.signal,
      }),
      input.budgetMs,
      () => controller.abort(),
    );
  } catch (error) {
    const failed =
      error instanceof AssistantUnavailableError ? "ia_indisponivel" : error instanceof Error && error.message === "tempo esgotado" ? "ia_demorou" : "ia_erro";
    console.warn(`[photo-match] comparação visual não respondeu (${failed}):`, error instanceof Error ? error.message : error);
    return { ...empty, failed, candidates: labels.length };
  }
  const tiers = tierVisionMatches(extraction.json, labels);
  if (!tiers) return { ...empty, failed: "json_invalido", candidates: labels.length };
  return { ...tiers, failed: null, candidates: labels.length };
}

type Candidate = { slug: string; name: string; imagePath: string };

/** Primeiro com os filtros da Lia; sem resultado, sem filtro — só peças públicas com foto. */
async function pickCandidates(db: DbOrTx, input: VisionMatchInput): Promise<Candidate[]> {
  const strict = await listCandidates(db, input, true);
  if (strict.length > 0) return strict;
  return listCandidates(db, input, false);
}

async function listCandidates(db: DbOrTx, input: VisionMatchInput, useFilters: boolean): Promise<Candidate[]> {
  const sdb = db as unknown as ServiceDb;
  const busca = useFilters ? input.filters.busca?.trim() : undefined;
  const categoria = useFilters ? input.filters.categoria?.trim() : undefined;
  const cor = useFilters ? input.filters.cor?.trim() : undefined;
  // Categoria que não existe não pode zerar a busca: só cai.
  const categorySlug = categoria ? await resolveCategorySlug(db, categoria) : null;
  let items = await listPublicProducts(sdb, {
    ...(busca ? { q: busca, includeDescription: true } : {}),
    ...(categorySlug ? { categorySlug } : {}),
    viewer: { customerId: input.customerId },
    limit: 200,
  });
  if (cor) {
    const withColor = await listProductIdsWithVariant(sdb, { cor });
    if (withColor) items = items.filter((item) => withColor.has(item.id));
  }
  return items
    .flatMap((item) => (item.imagePath ? [{ slug: item.slug, name: item.name, imagePath: item.imagePath }] : []))
    .slice(0, PHOTO_MATCH_MAX_CANDIDATES);
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error("tempo esgotado"));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
