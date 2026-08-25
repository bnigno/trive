// Catálogo PÚBLICO da loja (somente leitura) + cotação de frete.
// Fase 2: vitrine sem autenticação. Nada aqui muta estado — sem audit/outbox.
// Regra central: só é visível o que está ativo E tem preço ativo (price_versions
// status 'active'); preço exibido é sempre o do banco, nunca o do cliente.
import { and, asc, desc, eq, gte, ilike, isNull, lte, or, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { z } from "zod";

import * as schema from "@/db/schema";
import {
  categories,
  priceVersions,
  productImages,
  products,
  productVariants,
  shippingRates,
  stockLevels,
} from "@/db/schema";

/**
 * Base estrutural comum a Db (postgres.js), transações e o TestDb (PGlite),
 * mesmo padrão do src/services/catalog.ts. Injetado — nunca getDb() aqui.
 */
export type ServiceDb = PgDatabase<PgQueryResultHKT, typeof schema>;

// ---------------------------------------------------------------------------
// Erros de negócio
// ---------------------------------------------------------------------------

export class ServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Condições reutilizadas: "variante vendável" = ativa, não deletada e com
// preço ativo. Produto público = status 'active', não deletado, com ao menos
// uma variante vendável.
// ---------------------------------------------------------------------------

const sellableVariantJoin = () =>
  and(
    eq(productVariants.productId, products.id),
    eq(productVariants.isActive, true),
    isNull(productVariants.deletedAt),
  );

const activePriceJoin = () =>
  and(
    eq(priceVersions.productVariantId, productVariants.id),
    eq(priceVersions.status, "active"),
  );

// ---------------------------------------------------------------------------
// 1. listPublicProducts
// ---------------------------------------------------------------------------

const listPublicProductsSchema = z.object({
  categorySlug: z.string().trim().min(1).optional(),
  q: z.string().trim().min(1).optional(),
  limit: z.number().int().positive().max(200).default(60),
});

export type ListPublicProductsInput = z.input<typeof listPublicProductsSchema>;

export interface PublicProductListItem {
  id: string;
  name: string;
  slug: string;
  brand: string | null;
  categoryName: string | null;
  /** Menor preço ativo entre as variantes vendáveis. */
  priceFromCents: number;
  /** Maior preço ativo entre as variantes vendáveis. */
  priceToCents: number;
  /** Primeira imagem do produto por sort_order (path no Storage), ou null. */
  imagePath: string | null;
  /** true se a soma de disponível (on_hand - reserved) das variantes > 0. */
  available: boolean;
}

export async function listPublicProducts(
  db: ServiceDb,
  input: ListPublicProductsInput = {},
): Promise<PublicProductListItem[]> {
  const parsed = listPublicProductsSchema.parse(input);

  const filters = [eq(products.status, "active"), isNull(products.deletedAt)];
  if (parsed.categorySlug) filters.push(eq(categories.slug, parsed.categorySlug));
  if (parsed.q) {
    const pattern = `%${parsed.q}%`;
    filters.push(
      or(ilike(products.name, pattern), ilike(products.brand, pattern))!,
    );
  }

  const rows = await db
    .select({
      id: products.id,
      name: products.name,
      slug: products.slug,
      brand: products.brand,
      categoryName: categories.name,
      priceFromCents: sql<string>`min(${priceVersions.priceCents})`,
      priceToCents: sql<string>`max(${priceVersions.priceCents})`,
      availableSum: sql<string>`coalesce(sum(greatest(coalesce(${stockLevels.onHand}, 0) - coalesce(${stockLevels.reserved}, 0), 0)), 0)`,
      imagePath: sql<string | null>`(
        select pi.storage_path from product_images pi
        where pi.product_id = ${products.id}
        order by pi.sort_order asc, pi.created_at asc
        limit 1
      )`,
    })
    .from(products)
    // INNER joins: produto sem variante ativa com preço ativo fica de fora.
    .innerJoin(productVariants, sellableVariantJoin())
    .innerJoin(priceVersions, activePriceJoin())
    .leftJoin(stockLevels, eq(stockLevels.productVariantId, productVariants.id))
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .where(and(...filters))
    .groupBy(products.id, categories.name)
    .orderBy(desc(products.createdAt))
    .limit(parsed.limit);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    brand: row.brand,
    categoryName: row.categoryName,
    priceFromCents: Number(row.priceFromCents),
    priceToCents: Number(row.priceToCents),
    imagePath: row.imagePath,
    available: Number(row.availableSum) > 0,
  }));
}

// ---------------------------------------------------------------------------
// 2. listPublicCategories
// ---------------------------------------------------------------------------

export interface PublicCategory {
  id: string;
  name: string;
  slug: string;
  /** Quantidade de produtos públicos (ativos com preço ativo) na categoria. */
  productCount: number;
}

export async function listPublicCategories(db: ServiceDb): Promise<PublicCategory[]> {
  const rows = await db
    .select({
      id: categories.id,
      name: categories.name,
      slug: categories.slug,
      productCount: sql<string>`count(distinct ${products.id})`,
    })
    .from(categories)
    .innerJoin(
      products,
      and(
        eq(products.categoryId, categories.id),
        eq(products.status, "active"),
        isNull(products.deletedAt),
      ),
    )
    .innerJoin(productVariants, sellableVariantJoin())
    .innerJoin(priceVersions, activePriceJoin())
    .groupBy(categories.id)
    .orderBy(asc(categories.name));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    productCount: Number(row.productCount),
  }));
}

// ---------------------------------------------------------------------------
// 3. getPublicProductBySlug
// ---------------------------------------------------------------------------

export interface PublicVariant {
  variantId: string;
  sku: string;
  attributes: Record<string, string>;
  priceCents: number;
  compareAtPriceCents: number | null;
  /** Disponível para venda: max(0, on_hand - reserved). */
  availableQty: number;
  weightGrams: number | null;
}

export interface PublicProductDetail {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  brand: string | null;
  categoryName: string | null;
  /** Eixos de variação, ex.: ["cor", "tamanho"]. */
  attributesSchema: string[];
  /** Paths das imagens no Storage, ordenados por sort_order. */
  images: string[];
  variants: PublicVariant[];
}

export async function getPublicProductBySlug(
  db: ServiceDb,
  slug: string,
): Promise<PublicProductDetail | null> {
  const parsedSlug = z.string().trim().min(1).parse(slug);

  const [row] = await db
    .select({ product: products, categoryName: categories.name })
    .from(products)
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .where(
      and(
        eq(products.slug, parsedSlug),
        eq(products.status, "active"),
        isNull(products.deletedAt),
      ),
    )
    .limit(1);
  if (!row) return null;
  const product = row.product;

  const variantRows = await db
    .select({
      variantId: productVariants.id,
      sku: productVariants.sku,
      attributes: productVariants.attributes,
      weightGrams: productVariants.weightGrams,
      priceCents: priceVersions.priceCents,
      compareAtPriceCents: priceVersions.compareAtPriceCents,
      onHand: sql<string>`coalesce(${stockLevels.onHand}, 0)`,
      reserved: sql<string>`coalesce(${stockLevels.reserved}, 0)`,
    })
    .from(productVariants)
    .innerJoin(priceVersions, activePriceJoin())
    .leftJoin(stockLevels, eq(stockLevels.productVariantId, productVariants.id))
    .where(
      and(
        eq(productVariants.productId, product.id),
        eq(productVariants.isActive, true),
        isNull(productVariants.deletedAt),
      ),
    )
    .orderBy(asc(productVariants.createdAt), asc(productVariants.sku));

  // Sem nenhuma variante vendável, o produto não existe para a vitrine.
  if (variantRows.length === 0) return null;

  const imageRows = await db
    .select({ path: productImages.storagePath })
    .from(productImages)
    .where(eq(productImages.productId, product.id))
    .orderBy(asc(productImages.sortOrder), asc(productImages.createdAt));

  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    description: product.description,
    brand: product.brand,
    categoryName: row.categoryName,
    attributesSchema: (product.attributesSchema ?? []) as string[],
    images: imageRows.map((image) => image.path),
    variants: variantRows.map((variant) => ({
      variantId: variant.variantId,
      sku: variant.sku,
      attributes: (variant.attributes ?? {}) as Record<string, string>,
      priceCents: Number(variant.priceCents),
      compareAtPriceCents:
        variant.compareAtPriceCents == null ? null : Number(variant.compareAtPriceCents),
      availableQty: Math.max(0, Number(variant.onHand) - Number(variant.reserved)),
      weightGrams: variant.weightGrams,
    })),
  };
}

// ---------------------------------------------------------------------------
// 4. quoteShipping
// ---------------------------------------------------------------------------

/**
 * Peso padrão (em gramas) usado para itens cuja variante não tem weightGrams
 * cadastrado. Mantém a cotação de frete sempre possível.
 */
export const DEFAULT_ITEM_WEIGHT_GRAMS = 300;

/** Soma o peso do carrinho aplicando DEFAULT_ITEM_WEIGHT_GRAMS aos itens sem peso. */
export function computeTotalWeightGrams(
  items: ReadonlyArray<{ weightGrams: number | null | undefined; quantity: number }>,
): number {
  return items.reduce(
    (sum, item) => sum + (item.weightGrams ?? DEFAULT_ITEM_WEIGHT_GRAMS) * item.quantity,
    0,
  );
}

const quoteShippingSchema = z.object({
  cep: z.string(),
  totalWeightGrams: z
    .number()
    .int({ message: "O peso total deve ser um inteiro em gramas." })
    .min(0, { message: "O peso total não pode ser negativo." }),
});

export type QuoteShippingInput = z.input<typeof quoteShippingSchema>;

export interface ShippingQuote {
  rateId: string;
  name: string;
  priceCents: number;
  deliveryDaysMin: number;
  deliveryDaysMax: number;
}

/** Normaliza para 8 dígitos; lança ServiceError (pt-BR) se o CEP for inválido. */
export function normalizeCep(cep: string): string {
  const digits = cep.replace(/\D/g, "");
  if (digits.length !== 8) {
    throw new ServiceError("cep_invalido", "CEP inválido. Informe um CEP com 8 dígitos.");
  }
  return digits;
}

/**
 * Cota o frete pelas faixas de shipping_rates: CEP entre cepStart..cepEnd
 * (comparação de STRING de 8 dígitos zero-padded) e peso entre min..max
 * (fronteiras INCLUSIVAS). Array vazio = não entregamos para este CEP.
 */
export async function quoteShipping(
  db: ServiceDb,
  input: QuoteShippingInput,
): Promise<ShippingQuote[]> {
  const parsed = quoteShippingSchema.parse(input);
  const cep = normalizeCep(parsed.cep);

  const rows = await db
    .select({
      rateId: shippingRates.id,
      name: shippingRates.name,
      priceCents: shippingRates.priceCents,
      deliveryDaysMin: shippingRates.deliveryDaysMin,
      deliveryDaysMax: shippingRates.deliveryDaysMax,
    })
    .from(shippingRates)
    .where(
      and(
        eq(shippingRates.isActive, true),
        lte(shippingRates.cepStart, cep),
        gte(shippingRates.cepEnd, cep),
        lte(shippingRates.weightMinGrams, parsed.totalWeightGrams),
        gte(shippingRates.weightMaxGrams, parsed.totalWeightGrams),
      ),
    )
    .orderBy(asc(shippingRates.priceCents), asc(shippingRates.sortOrder));

  return rows.map((row) => ({
    rateId: row.rateId,
    name: row.name,
    priceCents: Number(row.priceCents),
    deliveryDaysMin: Number(row.deliveryDaysMin),
    deliveryDaysMax: Number(row.deliveryDaysMax),
  }));
}

// ---------------------------------------------------------------------------
// 5. publicImageUrl — função PURA (roda em server component da vitrine).
// Sem service key: bucket product-images é público no Supabase Storage.
// ---------------------------------------------------------------------------

export function publicImageUrl(path: string): string {
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "");
  if (!base) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL não configurada.");
  }
  return `${base}/storage/v1/object/public/product-images/${path}`;
}

/** URL do thumbnail derivada por convenção (-full.webp -> -thumb.webp). */
export function publicThumbUrl(path: string): string {
  return publicImageUrl(path.replace("-full.webp", "-thumb.webp"));
}
