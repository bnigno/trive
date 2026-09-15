// Folha de etiquetas de uma peça: junta a ficha do produto (variações com
// preço ativo) ao nome da loja e deixa a conta com o core.
import { z } from "zod";

import { planProductLabels, type LabelPlan } from "@/core/catalog/labels";
import { getProductDetail, type ServiceDb } from "@/services/catalog";
import { getStoreName } from "@/services/settings";

const getProductLabelSheetSchema = z.object({
  productId: z.uuid(),
  /** null = uma etiqueta por variação ativa. Chave = id da variação. */
  quantities: z.record(z.uuid(), z.number().int().min(0)).nullable(),
});

export type GetProductLabelSheetInput = z.input<typeof getProductLabelSheetSchema>;

export type ProductLabelSheet = LabelPlan & {
  productId: string;
  productName: string;
  storeName: string;
};

/** Lança o erro de `getProductDetail` quando o produto não existe. */
export async function getProductLabelSheet(
  db: ServiceDb,
  input: GetProductLabelSheetInput,
): Promise<ProductLabelSheet> {
  const parsed = getProductLabelSheetSchema.parse(input);
  const [detail, storeName] = await Promise.all([
    getProductDetail(db, parsed.productId),
    getStoreName(db),
  ]);
  const axes = Array.isArray(detail.attributesSchema)
    ? (detail.attributesSchema as unknown[]).filter((axis): axis is string => typeof axis === "string")
    : [];
  const plan = planProductLabels({
    storeName,
    productName: detail.name,
    axes,
    variants: detail.variants.map((variant) => ({
      id: variant.id,
      sku: variant.sku,
      attributes: variant.attributes,
      isActive: variant.isActive,
      priceCents: variant.activePriceCents,
    })),
    quantities: parsed.quantities,
  });
  return { ...plan, productId: detail.id, productName: detail.name, storeName };
}
