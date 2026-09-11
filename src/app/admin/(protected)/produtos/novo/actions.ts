"use server";

import { revalidatePath } from "next/cache";
import { z, ZodError } from "zod";
import {
  MAX_AXIS_VALUES,
  MAX_GRID_ROWS,
  gridAxes,
  selectGridVariants,
} from "@/core/catalog/variant-grid";
import { normalizeSkuInput, validateSku } from "@/core/catalog/sku";
import { getSalesAssistant } from "@/adapters/assistant";
import type { ProductDraft } from "@/core/catalog/product-draft";
import { DRAFT_MAX_PHOTOS } from "@/core/catalog/product-draft";
import { getDb } from "@/db/client";
import { parseBRLToCents } from "@/lib/money";
import { requireOwner } from "@/services/auth";
import { createProduct, ServiceError } from "@/services/catalog";
import { draftProductFromPhotos } from "@/services/product-draft";
import { ServiceError as SettingsServiceError } from "@/services/settings";

export type FormState = {
  error?: string;
  success?: string;
  /**
   * Fase 1 concluída: o produto EXISTE no banco. A partir daqui o cliente
   * manda as fotos uma a uma — nada do que falhar depois desfaz o cadastro.
   */
  productId?: string;
};

function toErrorState(error: unknown): FormState {
  if (error instanceof ServiceError) {
    if (error.code === "sku_duplicado") {
      return {
        error:
          "Já existe uma variação com um desses códigos (SKU). Ajuste os códigos na grade — por exemplo, acrescente -2 no fim — e tente de novo.",
      };
    }
    return { error: error.message };
  }
  if (error instanceof ZodError) {
    return { error: error.issues[0]?.message ?? "Dados inválidos." };
  }
  return { error: "Algo deu errado, tente novamente." };
}

/** Texto em reais → centavos. Campo vazio é ausência, não zero. */
function optionalCents(label: string) {
  return z
    .string()
    .trim()
    .transform((value, ctx) => {
      if (value === "") return undefined;
      let cents: number;
      try {
        cents = parseBRLToCents(value);
      } catch {
        ctx.addIssue({
          code: "custom",
          message: `${label} está num formato que não entendi. Escreva assim: 1.234,56.`,
        });
        return z.NEVER;
      }
      if (cents < 0) {
        ctx.addIssue({ code: "custom", message: `${label} não pode ser negativo.` });
        return z.NEVER;
      }
      return cents;
    });
}

/**
 * Quantidade da linha da grade. Branco vira null de propósito: é o jeito de o
 * dono dizer que aquela combinação não existe (o verde só veio em P e G).
 */
const quantitySchema = z
  .string()
  .trim()
  .transform((value, ctx) => {
    if (value === "") return null;
    if (!/^\d{1,7}$/.test(value)) {
      ctx.addIssue({
        code: "custom",
        message:
          "A quantidade precisa ser um número inteiro, como 0, 3 ou 12. Deixe em branco se a combinação não existe.",
      });
      return z.NEVER;
    }
    return Number(value);
  });

const rowSchema = z.object({
  attributes: z.record(z.string(), z.string()).default({}),
  // Em branco, o servidor sugere pelo nome; digitado, passa pela regra do
  // core (caixa alta, só letras/números/hífen, teto do menu do WhatsApp).
  sku: z
    .string()
    .default("")
    .transform((value) => (value.trim() === "" ? "" : normalizeSkuInput(value)))
    .superRefine((sku, ctx) => {
      if (sku === "") return;
      const problem = validateSku(sku);
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    }),
  quantity: quantitySchema,
  cost: optionalCents("O custo"),
});

const axisValuesSchema = z
  .array(z.string())
  .max(
    MAX_AXIS_VALUES,
    `São no máximo ${MAX_AXIS_VALUES} cores e ${MAX_AXIS_VALUES} tamanhos por produto.`,
  )
  .default([]);

/** Peso da peça em gramas: vale para todas as combinações, como o preço. */
const weightSchema = z
  .string()
  .trim()
  .transform((value, ctx) => {
    if (value === "") return undefined;
    if (!/^\d{1,5}$/.test(value) || Number(value) <= 0) {
      ctx.addIssue({
        code: "custom",
        message: "O peso precisa ser um número inteiro de gramas, como 320. Deixe em branco para definir depois.",
      });
      return z.NEVER;
    }
    return Number(value);
  });

const payloadSchema = z.object({
  name: z.string().trim().min(1, "Informe o nome do produto."),
  weightGrams: weightSchema.optional(),
  description: z.string().trim().default(""),
  composition: z.string().trim().default(""),
  careNotes: z.string().trim().default(""),
  fitNotes: z.string().trim().default(""),
  brand: z.string().trim().default(""),
  categoryId: z
    .string()
    .trim()
    .default("")
    .refine(
      (value) => value === "" || z.uuid().safeParse(value).success,
      "Categoria inválida. Escolha uma da lista.",
    ),
  colors: axisValuesSchema,
  sizes: axisValuesSchema,
  price: optionalCents("O preço de venda"),
  rows: z
    .array(rowSchema)
    .min(1, "Preencha a grade de variações.")
    .max(
      MAX_GRID_ROWS,
      `A grade passou de ${MAX_GRID_ROWS} combinações. Tire algumas cores ou tamanhos e cadastre o resto depois.`,
    ),
});

export async function createProductAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireOwner("produtos");

  let raw: unknown;
  try {
    raw = JSON.parse(String(formData.get("payload") ?? ""));
  } catch {
    return {
      error: "Não consegui ler os dados desta tela. Recarregue a página e tente de novo.",
    };
  }

  const parsed = payloadSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }
  const data = parsed.data;

  if (data.price !== undefined && data.price <= 0) {
    return {
      error:
        "O preço de venda precisa ser maior que zero. Deixe em branco para definir depois na calculadora.",
    };
  }

  // Os eixos saem das fichas de cor e tamanho, e não das chaves que vieram
  // dentro de cada linha; SKU, quantidade e custo da tela são sugestão e são
  // remontados aqui pelas mesmas funções que desenharam a grade.
  const axes = gridAxes(data.colors, data.sizes);
  const variants = selectGridVariants({
    name: data.name,
    axes,
    rows: data.rows.map((row) => ({
      attributes: row.attributes,
      sku: row.sku,
      quantity: row.quantity,
      costCents: row.cost,
    })),
    priceCents: data.price,
    weightGrams: data.weightGrams,
  });

  if (variants.length === 0) {
    return {
      error:
        "Preencha a quantidade de pelo menos uma combinação — é a quantidade que diz quais existem.",
    };
  }

  let productId: string;
  try {
    const db = getDb();
    const result = await createProduct(db, {
      name: data.name,
      description: data.description || undefined,
      composition: data.composition || undefined,
      careNotes: data.careNotes || undefined,
      fitNotes: data.fitNotes || undefined,
      brand: data.brand || undefined,
      categoryId: data.categoryId || undefined,
      attributesSchema: axes,
      variants,
      userId: user.id,
    });
    productId = result.product.id;
  } catch (error) {
    return toErrorState(error);
  }

  revalidatePath("/admin/produtos");
  // Sem redirect: quem navega é o cliente, depois de mandar as fotos.
  return { productId };
}


// ---------------------------------------------------------------------------
// "Começar pela foto": as fotos viram um rascunho da ficha (nada é salvo)
// ---------------------------------------------------------------------------

export type DraftFormState = {
  error?: string;
  draft?: ProductDraft;
  suggestedPriceCents?: number | null;
  estimatedCostUsdCents?: number;
};

/** Fotos já reduzidas no navegador; o limite do corpo da action é 8 MB. */
const MAX_DRAFT_PHOTO_BYTES = 2 * 1024 * 1024;

export async function draftFromPhotosAction(
  _prev: DraftFormState,
  formData: FormData,
): Promise<DraftFormState> {
  const user = await requireOwner("produtos");

  const files = formData
    .getAll("photos")
    .filter((entry): entry is File => entry instanceof File && entry.size > 0);
  if (files.length === 0) {
    return { error: "Escolha ao menos uma foto da peça." };
  }
  if (files.length > DRAFT_MAX_PHOTOS) {
    return { error: `Use no máximo ${DRAFT_MAX_PHOTOS} fotos.` };
  }
  for (const file of files) {
    if (!file.type.startsWith("image/")) {
      return { error: "Só consigo ler fotos (imagens)." };
    }
    if (file.size > MAX_DRAFT_PHOTO_BYTES) {
      return { error: "Uma das fotos ficou grande demais mesmo depois de reduzida. Tente com outra foto." };
    }
  }

  let costCents: number;
  try {
    costCents = parseBRLToCents(String(formData.get("cost") ?? ""));
  } catch {
    return { error: "Escreva quanto a peça custou assim: 120,00." };
  }
  if (costCents <= 0) {
    return { error: "Informe quanto a peça custou para você — é com isso que eu sugiro o preço." };
  }

  try {
    const photos = await Promise.all(
      files.map(async (file) => ({
        data: Buffer.from(await file.arrayBuffer()),
        contentType: file.type,
      })),
    );
    const result = await draftProductFromPhotos(getDb(), getSalesAssistant(), {
      photos,
      costCents,
      userId: user.id,
    });
    return {
      draft: result.draft,
      suggestedPriceCents: result.suggestedPrice?.priceCents ?? null,
      estimatedCostUsdCents: result.estimatedCostUsdCents,
    };
  } catch (error) {
    if (error instanceof SettingsServiceError) return { error: error.message };
    return toErrorState(error);
  }
}
