// Prontidão das peças para a loja abrir: junta em três consultas os fatos que
// a regra pura (src/core/catalog/readiness.ts) precisa — status, descrição,
// sala e capa, fotos, e por variação preço ativo/pendente, estoque e peso.
// Só leitura; nada aqui grava.
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import {
  assessProductReadiness,
  type LiaReadinessSummary,
  type ProductReadiness,
  type ReadinessSummary,
  type ReadinessVariantFacts,
  summarizeLiaReadiness,
  summarizeReadiness,
} from "@/core/catalog/readiness";
import {
  categories,
  productImages,
  productVariants,
  products,
  stockLevels,
} from "@/db/schema";
import type { ServiceDb } from "@/services/catalog";

export type ListProductReadinessInput = {
  /** Restringe às peças da página; ausente = todas as não apagadas. */
  productIds?: readonly string[];
};

export async function listProductReadiness(
  db: ServiceDb,
  input: ListProductReadinessInput = {},
): Promise<Map<string, ProductReadiness>> {
  const result = new Map<string, ProductReadiness>();
  if (input.productIds && input.productIds.length === 0) return result;

  const productFilter = input.productIds
    ? and(isNull(products.deletedAt), inArray(products.id, [...input.productIds]))
    : isNull(products.deletedAt);

  const productRows = await db
    .select({
      id: products.id,
      status: products.status,
      description: products.description,
      composition: products.composition,
      fitNotes: products.fitNotes,
      curatorNote: products.curatorNote,
      pieceType: products.pieceType,
      categoryId: products.categoryId,
      coverPath: categories.coverPath,
    })
    .from(products)
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .where(productFilter);
  if (productRows.length === 0) return result;

  const ids = productRows.map((row) => row.id);

  const [imageRows, variantRows] = await Promise.all([
    db
      .select({
        productId: productImages.productId,
        total: sql<string>`count(*)`,
      })
      .from(productImages)
      .where(inArray(productImages.productId, ids))
      .groupBy(productImages.productId),
    db
      .select({
        productId: productVariants.productId,
        isActive: productVariants.isActive,
        weightGrams: productVariants.weightGrams,
        onHand: sql<string>`coalesce(${stockLevels.onHand}, 0)`,
        reserved: sql<string>`coalesce(${stockLevels.reserved}, 0)`,
        hasActivePrice: sql<boolean>`exists (
          select 1 from price_versions pv
          where pv.product_variant_id = ${productVariants.id} and pv.status = 'active'
        )`,
        hasPendingPrice: sql<boolean>`exists (
          select 1 from price_versions pv
          where pv.product_variant_id = ${productVariants.id} and pv.status = 'pending_approval'
        )`,
      })
      .from(productVariants)
      .leftJoin(stockLevels, eq(stockLevels.productVariantId, productVariants.id))
      .where(
        and(inArray(productVariants.productId, ids), isNull(productVariants.deletedAt)),
      ),
  ]);

  const photosByProduct = new Map(imageRows.map((row) => [row.productId, Number(row.total)]));
  const variantsByProduct = new Map<string, ReadinessVariantFacts[]>();
  for (const row of variantRows) {
    const list = variantsByProduct.get(row.productId) ?? [];
    list.push({
      isActive: row.isActive,
      weightGrams: row.weightGrams,
      hasActivePrice: row.hasActivePrice === true,
      hasPendingPrice: row.hasPendingPrice === true,
      available: Number(row.onHand) - Number(row.reserved),
    });
    variantsByProduct.set(row.productId, list);
  }

  for (const row of productRows) {
    result.set(
      row.id,
      assessProductReadiness({
        status: row.status,
        descriptionLength: (row.description ?? "").trim().length,
        compositionLength: (row.composition ?? "").trim().length,
        fitNotesLength: (row.fitNotes ?? "").trim().length,
        curatorNoteLength: (row.curatorNote ?? "").trim().length,
        pieceType: row.pieceType,
        photoCount: photosByProduct.get(row.id) ?? 0,
        categoryId: row.categoryId,
        categoryHasCover: row.coverPath !== null && row.coverPath !== undefined,
        variants: variantsByProduct.get(row.id) ?? [],
      }),
    );
  }
  return result;
}

/** O termômetro do painel: quantas peças (não arquivadas) estão prontas. */
export async function getReadinessSummary(db: ServiceDb): Promise<ReadinessSummary> {
  const readiness = await listProductReadiness(db);
  return summarizeReadiness([...readiness.values()]);
}

/** O card "O que falta para a Lia falar bem": quantas peças têm a ficha completa e o que falta, por campo. */
export async function getLiaReadinessSummary(db: ServiceDb): Promise<LiaReadinessSummary> {
  return summarizeLiaReadiness([...(await listProductReadiness(db)).values()]);
}
