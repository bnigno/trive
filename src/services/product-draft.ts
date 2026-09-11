// "Começar pela foto": as fotos da peça viram um RASCUNHO da ficha.
//
// Nada é gravado no catálogo aqui — o rascunho volta para a tela de cadastro,
// a dona revisa e só então toca "Criar produto". O que fica gravado é o
// audit (uso de tokens, custo estimado, avisos) para a dona saber quanto a
// ficha custou.

import { asc } from "drizzle-orm";
import { z } from "zod";

import {
  AssistantUnavailableError,
  type SalesAssistant,
} from "@/adapters/assistant";
import { estimateUsageCostUsdCents, type ModelUsage } from "@/core/catalog/model-cost";
import {
  buildProductDraftPrompt,
  DRAFT_MAX_PHOTOS,
  normalizeProductDraft,
  PRODUCT_DRAFT_JSON_SCHEMA,
  PRODUCT_DRAFT_USER_TEXT,
  type ProductDraft,
} from "@/core/catalog/product-draft";
import { auditLog, categories } from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { ServiceError, getSettingsMap } from "@/services/settings";
import { suggestPriceForCost, type SuggestedPrice } from "@/services/pricing";
import { getStoreMap } from "@/services/store-catalog";
import { prepareImageForModel } from "@/services/wa-media";

/** Teto de tempo da chamada: a server action da Vercel tem 60 s. */
export const DRAFT_TIME_BUDGET_MS = 45_000;

const DEFAULT_DRAFT_MODEL = "claude-sonnet-5";

const draftInputSchema = z.object({
  photos: z
    .array(z.object({ data: z.instanceof(Buffer), contentType: z.string() }))
    .min(1, "Envie ao menos uma foto da peça.")
    .max(DRAFT_MAX_PHOTOS, `Envie no máximo ${DRAFT_MAX_PHOTOS} fotos.`),
  costCents: z.number().int().positive("Informe quanto a peça custou para você."),
  userId: z.uuid(),
});

export type DraftProductFromPhotosInput = z.input<typeof draftInputSchema>;

export type DraftProductFromPhotosResult = {
  draft: ProductDraft;
  suggestedPrice: SuggestedPrice | null;
  usage: ModelUsage;
  estimatedCostUsdCents: number;
  elapsedMs: number;
};

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ServiceError("ia_demorou", message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error as Error);
      },
    );
  });
}

/** Ausente = ligado: a ficha pela foto só some quando a dona desliga. */
export async function isCatalogDraftEnabled(db: DbOrTx): Promise<boolean> {
  const map = await getSettingsMap(db, ["catalog_draft_enabled"]);
  return map["catalog_draft_enabled"] !== false;
}

/**
 * Fotos (peça, etiqueta, tabela de medidas) + custo → ficha preenchida para
 * revisão: nome no tom da maison, sala, cores e tamanhos, descrição,
 * composição, cuidados, como veste, peso estimado e preço sugerido pela
 * política de margem vigente.
 */
export async function draftProductFromPhotos(
  db: DbOrTx,
  assistant: SalesAssistant,
  input: DraftProductFromPhotosInput,
): Promise<DraftProductFromPhotosResult> {
  const parsed = draftInputSchema.parse(input);
  if (!(await isCatalogDraftEnabled(db))) {
    throw new ServiceError(
      "ficha_pela_foto_desligada",
      "A ficha pela foto está desligada nas Configurações.",
    );
  }

  const startedAt = Date.now();
  const [images, settingsMap, categoryRows, storeMap] = await Promise.all([
    Promise.all(parsed.photos.map((photo) => prepareImageForModel(photo.data))),
    getSettingsMap(db, ["store_name", "store_manifesto", "bot_model"]),
    db
      .select({ id: categories.id, name: categories.name, slug: categories.slug })
      .from(categories)
      .orderBy(asc(categories.name)),
    getStoreMap(db),
  ]);

  const text = (key: string): string =>
    typeof settingsMap[key] === "string" ? (settingsMap[key] as string) : "";
  const model = text("bot_model") !== "" ? text("bot_model") : DEFAULT_DRAFT_MODEL;
  const system = buildProductDraftPrompt({
    storeName: text("store_name") !== "" ? text("store_name") : "TRIVÉ",
    manifesto: text("store_manifesto"),
    categories: categoryRows.map((row) => ({ name: row.name, slug: row.slug })),
    knownColors: storeMap.colors,
    knownSizes: storeMap.sizes,
  });

  let extraction;
  try {
    extraction = await withTimeout(
      assistant.extractFromPhotos({
        system,
        images: images.map(({ mediaType, base64 }) => ({ mediaType, base64 })),
        userText: PRODUCT_DRAFT_USER_TEXT,
        model,
        jsonSchema: PRODUCT_DRAFT_JSON_SCHEMA,
        maxTokens: 2048,
      }),
      DRAFT_TIME_BUDGET_MS,
      "A ficha demorou demais para ficar pronta. Tente de novo com menos fotos.",
    );
  } catch (error) {
    if (error instanceof AssistantUnavailableError) {
      throw new ServiceError("ia_indisponivel", `${error.message}. Preencha a ficha à mão por enquanto.`);
    }
    throw error;
  }

  let draft: ProductDraft;
  try {
    draft = normalizeProductDraft(extraction.json, { categories: categoryRows });
  } catch {
    throw new ServiceError(
      "ia_indisponivel",
      "A resposta do modelo não veio no formato esperado. Tente de novo ou preencha à mão.",
    );
  }

  const suggestedPrice = await suggestPriceForCost(db, parsed.costCents);
  const estimatedCostUsdCents = estimateUsageCostUsdCents(extraction.usage, model);
  const elapsedMs = Date.now() - startedAt;

  await db.insert(auditLog).values({
    actorType: "user",
    actorId: parsed.userId,
    action: "product.draft_from_photos",
    entityType: "product",
    entityId: null,
    after: {
      model,
      photos: parsed.photos.length,
      usage: extraction.usage,
      estimatedCostUsdCents,
      elapsedMs,
      name: draft.name,
      warnings: draft.warnings,
      suggestedPriceCents: suggestedPrice?.priceCents ?? null,
    },
  });

  return { draft, suggestedPrice, usage: extraction.usage, estimatedCostUsdCents, elapsedMs };
}
