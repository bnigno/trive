"use server";

import { revalidatePath } from "next/cache";
import { z, ZodError } from "zod";
import {
  MAX_AXIS_VALUES,
  MAX_GRID_ROWS,
  gridAxes,
  selectGridVariants,
} from "@/core/catalog/variant-grid";
import { getDb } from "@/db/client";
import { parseBRLToCents } from "@/lib/money";
import { requireOwner } from "@/services/auth";
import { createProduct, ServiceError } from "@/services/catalog";

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
  sku: z
    .string()
    .max(64, "O código (SKU) ficou longo demais: use até 64 caracteres.")
    .default(""),
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

const payloadSchema = z.object({
  name: z.string().trim().min(1, "Informe o nome do produto."),
  description: z.string().trim().default(""),
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
