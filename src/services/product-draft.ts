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
import { estimateUsageCostUsdCents, type ModelUsage } from "@/core/ai/model-cost";
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

function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Sem o abort a chamada seguiria até o fim — e seria cobrada.
      controller.abort();
      reject(new ServiceError("ia_demorou", message));
    }, ms);
    run(controller.signal).then(
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
  let images;
  try {
    images = await Promise.all(parsed.photos.map((photo) => prepareImageForModel(photo.data)));
  } catch {
    // HEIC do iPhone e afins: o sharp não decodifica. A dona precisa saber o
    // que fazer, e não gastamos a chamada ao modelo.
    throw new ServiceError(
      "foto_ilegivel",
      "Não consegui ler uma das fotos (formato não suportado, como HEIC). Nos ajustes da câmera escolha “Mais compatível” e fotografe de novo.",
    );
  }
  const [settingsMap, categoryRows, storeMap] = await Promise.all([
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

  /** Toda tentativa vira audit: a que falha também custou tokens. */
  const auditAttempt = async (after: Record<string, unknown>): Promise<void> => {
    await db.insert(auditLog).values({
      actorType: "user",
      actorId: parsed.userId,
      action: "product.draft_from_photos",
      entityType: "product",
      entityId: null,
      after: { model, photos: parsed.photos.length, elapsedMs: Date.now() - startedAt, ...after },
    });
  };

  let extraction;
  try {
    extraction = await withTimeout(
      (signal) =>
        assistant.extractFromPhotos({
          system,
          images: images.map(({ mediaType, base64 }) => ({ mediaType, base64 })),
          userText: PRODUCT_DRAFT_USER_TEXT,
          model,
          jsonSchema: PRODUCT_DRAFT_JSON_SCHEMA,
          maxTokens: 2048,
          signal,
        }),
      DRAFT_TIME_BUDGET_MS,
      "A ficha demorou demais para ficar pronta. Tente de novo com menos fotos.",
    );
  } catch (error) {
    await auditAttempt({
      ok: false,
      reason: error instanceof ServiceError ? error.code : "ia_indisponivel",
    });
    if (error instanceof AssistantUnavailableError) {
      throw new ServiceError("ia_indisponivel", `${error.message}. Preencha a ficha à mão por enquanto.`);
    }
    throw error;
  }

  let draft: ProductDraft;
  try {
    draft = normalizeProductDraft(extraction.json, { categories: categoryRows });
  } catch {
    await auditAttempt({
      ok: false,
      reason: "json_invalido",
      usage: extraction.usage,
      estimatedCostUsdCents: estimateUsageCostUsdCents(extraction.usage, model),
    });
    throw new ServiceError(
      "ia_indisponivel",
      "A resposta do modelo não veio no formato esperado. Tente de novo ou preencha à mão.",
    );
  }

  // Política de margem inviável (divisor ≤ 0) lança no core: o rascunho segue
  // sem preço em vez de se perder depois de a chamada já ter sido paga.
  let suggestedPrice = null;
  try {
    suggestedPrice = await suggestPriceForCost(db, parsed.costCents);
  } catch {
    draft.warnings.push(
      "Não consegui sugerir o preço: a política de margem atual não fecha com esse custo. Confira em Configurações › Preços.",
    );
  }
  const estimatedCostUsdCents = estimateUsageCostUsdCents(extraction.usage, model);
  const elapsedMs = Date.now() - startedAt;


  await auditAttempt({
    ok: true,
    usage: extraction.usage,
    estimatedCostUsdCents,
    name: draft.name,
    warnings: draft.warnings,
    suggestedPriceCents: suggestedPrice?.priceCents ?? null,
  });

  return { draft, suggestedPrice, usage: extraction.usage, estimatedCostUsdCents, elapsedMs };
}
