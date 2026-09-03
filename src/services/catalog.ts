// Serviço de catálogo: categorias, produtos, variações e imagens.
// Custos e preços são responsabilidade do serviço de pricing — aqui só se
// registra o custo inicial informado na criação do produto.
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { and, eq, ilike, isNull, like, or, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { z } from "zod";

import * as schema from "@/db/schema";
import {
  auditLog,
  categories,
  priceVersions,
  productImages,
  products,
  productVariants,
  stockLevels,
  stockMovements,
  variantCosts,
} from "@/db/schema";
import { normalizeAxisValue } from "@/core/catalog/attributes";
import { findColorAxis } from "@/core/catalog/product-images";
import { suggestMarginForPrice } from "@/core/pricing";
import { applyMovement } from "@/core/stock/ledger";
import type { FileStorage } from "@/adapters/storage";

/**
 * Base estrutural comum a Db (postgres.js), transações e o TestDb (PGlite).
 * DbOrTx (src/queue/enqueue.ts) é atribuível a este tipo; os serviços o
 * recebem injetado — nunca chamam getDb() internamente.
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

/** Concatena as mensagens da cadeia de causas para inspecionar erros do driver. */
function errorChainText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join("\n");
}

function mapCatalogUniqueViolation(error: unknown): ServiceError | null {
  const text = errorChainText(error);
  if (text.includes("product_variants_sku_unique")) {
    return new ServiceError(
      "sku_duplicado",
      "Já existe uma variação com este SKU.",
    );
  }
  if (text.includes("product_variants_product_id_attributes_unique")) {
    return new ServiceError(
      "atributos_duplicados",
      "Já existe uma variação deste produto com os mesmos atributos.",
    );
  }
  if (text.includes("products_slug_unique") || text.includes("categories_slug_unique")) {
    return new ServiceError(
      "slug_duplicado",
      "Já existe um cadastro com este identificador (slug). Tente novamente.",
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

type AuditEntry = {
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
};

async function writeAudit(db: ServiceDb, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    actorType: "user",
    actorId: entry.actorId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    before: entry.before ?? null,
    after: entry.after ?? null,
    reason: entry.reason ?? null,
  });
}

function slugify(input: string): string {
  const slug = input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "item";
}

function pickUniqueSlug(taken: ReadonlySet<string>, base: string): string {
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

async function uniqueProductSlug(db: ServiceDb, name: string): Promise<string> {
  const base = slugify(name);
  const rows = await db
    .select({ slug: products.slug })
    .from(products)
    .where(or(eq(products.slug, base), like(products.slug, `${base}-%`)));
  return pickUniqueSlug(new Set(rows.map((row) => row.slug)), base);
}

async function uniqueCategorySlug(db: ServiceDb, name: string): Promise<string> {
  const base = slugify(name);
  const rows = await db
    .select({ slug: categories.slug })
    .from(categories)
    .where(or(eq(categories.slug, base), like(categories.slug, `${base}-%`)));
  return pickUniqueSlug(new Set(rows.map((row) => row.slug)), base);
}

function canonicalAttributes(attributes: Record<string, string>): string {
  const sorted = Object.fromEntries(
    Object.entries(attributes).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  return JSON.stringify(sorted);
}

/**
 * Valores dos eixos na forma canônica do catálogo. Eixo que ficou sem valor
 * sai do objeto: ele não faz parte da identidade da variante, e um "" gravado
 * seria uma combinação diferente aos olhos do UNIQUE (product_id, attributes).
 */
function normalizeAttributeValues(
  attributes: Record<string, string>,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [axis, value] of Object.entries(attributes)) {
    const normalizedValue = normalizeAxisValue(value);
    if (normalizedValue) normalized[axis] = normalizedValue;
  }
  return normalized;
}

/**
 * Margem do preço digitado no cadastro, pelo inverso da calculadora de preços.
 * Taxa de pagamento e política de precificação ficam de fora: no cadastro elas
 * podem nem existir ainda, e quem as conhece é o serviço de pricing — que
 * recalcula a margem na primeira reprecificação.
 */
function initialMarginRate(costCents: number, priceCents: number): number {
  return suggestMarginForPrice(
    {
      costCents,
      otherFixedCents: 0,
      otherRate: 0,
      feePercentRate: 0,
      feeFixedCents: 0,
      shippingSubsidyCents: 0,
      rounding: { mode: "none", direction: "up" },
    },
    priceCents,
  );
}

async function requireProduct(db: ServiceDb, productId: string) {
  const [product] = await db
    .select()
    .from(products)
    .where(and(eq(products.id, productId), isNull(products.deletedAt)))
    .limit(1);
  if (!product) {
    throw new ServiceError("nao_encontrado", "Produto não encontrado.");
  }
  return product;
}

// ---------------------------------------------------------------------------
// Categorias
// ---------------------------------------------------------------------------

const createCategorySchema = z.object({
  name: z.string().trim().min(1, "Informe o nome da categoria."),
  parentId: z.uuid().optional(),
  userId: z.uuid(),
});

export type CreateCategoryInput = z.input<typeof createCategorySchema>;

export async function createCategory(db: ServiceDb, input: CreateCategoryInput) {
  const parsed = createCategorySchema.parse(input);
  try {
    return await db.transaction(async (tx) => {
      const slug = await uniqueCategorySlug(tx, parsed.name);
      const [category] = await tx
        .insert(categories)
        .values({ name: parsed.name, slug, parentId: parsed.parentId ?? null })
        .returning();
      await writeAudit(tx, {
        actorId: parsed.userId,
        action: "category.create",
        entityType: "category",
        entityId: category.id,
        after: { name: category.name, slug, parentId: category.parentId },
      });
      return category;
    });
  } catch (error) {
    throw mapCatalogUniqueViolation(error) ?? error;
  }
}

// ---------------------------------------------------------------------------
// Produtos e variações
// ---------------------------------------------------------------------------

const variantInputSchema = z.object({
  sku: z.string().trim().min(1, "Informe o SKU da variação."),
  attributes: z.record(z.string(), z.string()).default({}),
  costCents: z.number().int().min(0).optional(),
  // Quantidade em mãos no dia do cadastro; vira movimento 'purchase_in'.
  initialQuantity: z
    .number()
    .int()
    .min(0, "A quantidade inicial não pode ser negativa.")
    .optional(),
  // Preço de venda inicial; vira a versão de preço ativa da variação.
  priceCents: z
    .number()
    .int()
    .positive("O preço da variação deve ser maior que zero.")
    .optional(),
  barcodeEan: z.string().trim().min(1).optional(),
  weightGrams: z.number().int().positive().optional(),
  lengthMm: z.number().int().positive().optional(),
  widthMm: z.number().int().positive().optional(),
  heightMm: z.number().int().positive().optional(),
});

const createProductSchema = z.object({
  name: z.string().trim().min(1, "Informe o nome do produto."),
  description: z.string().optional(),
  brand: z.string().trim().min(1).optional(),
  categoryId: z.uuid().optional(),
  // Eixos de variação, ex.: ["cor", "tamanho"].
  attributesSchema: z.array(z.string().trim().min(1)).default([]),
  // Produto sem variação = 1 variante com attributes {}.
  variants: z.array(variantInputSchema).min(1, "Cadastre ao menos uma variação."),
  userId: z.uuid(),
});

export type CreateProductInput = z.input<typeof createProductSchema>;

export async function createProduct(db: ServiceDb, input: CreateProductInput) {
  const parsed = createProductSchema.parse(input);

  // Normalizar ANTES da pré-checagem: "verde" e "Verde" são a mesma variação,
  // e é assim, já normalizado, que o UNIQUE do banco vai compará-los.
  const variants = parsed.variants.map((variant) => ({
    ...variant,
    attributes: normalizeAttributeValues(variant.attributes),
  }));

  const skus = new Set<string>();
  const attributeKeys = new Set<string>();
  for (const variant of variants) {
    if (skus.has(variant.sku)) {
      throw new ServiceError(
        "sku_duplicado",
        `SKU repetido no cadastro: "${variant.sku}".`,
      );
    }
    skus.add(variant.sku);
    const key = canonicalAttributes(variant.attributes);
    if (attributeKeys.has(key)) {
      throw new ServiceError(
        "atributos_duplicados",
        "Há variações com os mesmos atributos no cadastro.",
      );
    }
    attributeKeys.add(key);
  }

  try {
    return await db.transaction(async (tx) => {
      const slug = await uniqueProductSlug(tx, parsed.name);
      const [product] = await tx
        .insert(products)
        .values({
          name: parsed.name,
          slug,
          description: parsed.description ?? null,
          brand: parsed.brand ?? null,
          categoryId: parsed.categoryId ?? null,
          attributesSchema: parsed.attributesSchema,
        })
        .returning();

      const insertedVariants = await tx
        .insert(productVariants)
        .values(
          variants.map((variant) => ({
            productId: product.id,
            sku: variant.sku,
            attributes: variant.attributes,
            barcodeEan: variant.barcodeEan ?? null,
            weightGrams: variant.weightGrams ?? null,
            lengthMm: variant.lengthMm ?? null,
            widthMm: variant.widthMm ?? null,
            heightMm: variant.heightMm ?? null,
            costCents: variant.costCents ?? 0,
          })),
        )
        .returning({ id: productVariants.id, sku: productVariants.sku });

      await tx.insert(stockLevels).values(
        insertedVariants.map((variant) => ({
          productVariantId: variant.id,
          onHand: 0,
          reserved: 0,
        })),
      );

      // Custo inicial vai também para o ledger append-only de custos.
      const initialCosts = variants
        .map((variant, index) => ({ variant, id: insertedVariants[index].id }))
        .filter(({ variant }) => variant.costCents !== undefined);
      if (initialCosts.length > 0) {
        await tx.insert(variantCosts).values(
          initialCosts.map(({ variant, id }) => ({
            productVariantId: id,
            costCents: variant.costCents!,
            source: "manual",
            note: "Custo inicial no cadastro do produto",
            createdBy: parsed.userId,
          })),
        );
      }

      const now = new Date();
      for (const [index, variant] of variants.entries()) {
        const variantId = insertedVariants[index].id;

        const initialQuantity = variant.initialQuantity ?? 0;
        if (initialQuantity > 0) {
          // Saldo derivado do ledger, como em receiveStock. Sem SELECT ... FOR
          // UPDATE: a variação nasceu nesta transação, nenhuma outra a enxerga.
          const level = applyMovement(
            { onHand: 0, reserved: 0 },
            { type: "purchase_in", quantityDelta: initialQuantity },
          );
          await tx.insert(stockMovements).values({
            productVariantId: variantId,
            type: "purchase_in",
            quantityDelta: initialQuantity,
            unitCostCents: variant.costCents ?? null,
            referenceType: "product",
            referenceId: product.id,
            idempotencyKey: `purchase_in:${product.id}:${variantId}`,
            note: "Estoque inicial no cadastro do produto",
            createdBy: parsed.userId,
          });
          await tx
            .update(stockLevels)
            .set({
              onHand: level.onHand,
              reserved: level.reserved,
              updatedAt: sql`now()`,
            })
            .where(eq(stockLevels.productVariantId, variantId));
        }

        if (variant.priceCents !== undefined) {
          // Preço do cadastro entra ativo direto: é a decisão do dono, não há
          // preço anterior a proteger e a variação acabou de nascer (v1, sem
          // conflito com o índice de um ativo por variação). O fluxo de
          // aprovação do pricing cuida das mudanças daqui em diante.
          const costCents = variant.costCents ?? 0;
          await tx.insert(priceVersions).values({
            productVariantId: variantId,
            versionNumber: 1,
            status: "active",
            priceCents: variant.priceCents,
            origin: "initial",
            breakdown: {
              note: "Preço informado no cadastro do produto, sem passar pela calculadora.",
              manualPriceCents: variant.priceCents,
              costSnapshotCents: costCents,
            },
            costSnapshotCents: costCents,
            // numeric(7,4) em modo string: gravar com exatamente 4 casas.
            computedMarginRate: initialMarginRate(
              costCents,
              variant.priceCents,
            ).toFixed(4),
            requiresApproval: false,
            createdBy: parsed.userId,
            approvedBy: parsed.userId,
            approvedAt: now,
            activatedAt: now,
          });
        }
      }

      await writeAudit(tx, {
        actorId: parsed.userId,
        action: "product.create",
        entityType: "product",
        entityId: product.id,
        after: {
          name: product.name,
          slug,
          variantSkus: insertedVariants.map((variant) => variant.sku),
        },
      });

      return { product, variants: insertedVariants };
    });
  } catch (error) {
    throw mapCatalogUniqueViolation(error) ?? error;
  }
}

const updateProductSchema = z.object({
  productId: z.uuid(),
  userId: z.uuid(),
  name: z.string().trim().min(1).optional(),
  description: z.string().nullable().optional(),
  brand: z.string().trim().min(1).nullable().optional(),
  categoryId: z.uuid().nullable().optional(),
  supplierId: z.uuid().nullable().optional(),
  // 'archived' apenas oculta do catálogo; pedidos antigos preservam snapshots.
  status: z.enum(["draft", "active", "archived"]).optional(),
  attributesSchema: z.array(z.string().trim().min(1)).optional(),
});

export type UpdateProductInput = z.input<typeof updateProductSchema>;

export async function updateProduct(db: ServiceDb, input: UpdateProductInput) {
  const parsed = updateProductSchema.parse(input);
  return db.transaction(async (tx) => {
    const current = await requireProduct(tx, parsed.productId);

    const patch: Partial<typeof current> = {};
    if (parsed.name !== undefined) patch.name = parsed.name;
    if (parsed.description !== undefined) patch.description = parsed.description;
    if (parsed.brand !== undefined) patch.brand = parsed.brand;
    if (parsed.categoryId !== undefined) patch.categoryId = parsed.categoryId;
    if (parsed.supplierId !== undefined) patch.supplierId = parsed.supplierId;
    if (parsed.status !== undefined) patch.status = parsed.status;
    if (parsed.attributesSchema !== undefined) {
      patch.attributesSchema = parsed.attributesSchema;
    }
    if (Object.keys(patch).length === 0) return current;

    const [updated] = await tx
      .update(products)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(products.id, parsed.productId))
      .returning();

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const key of Object.keys(patch) as (keyof typeof patch)[]) {
      before[key] = current[key];
      after[key] = updated[key];
    }
    await writeAudit(tx, {
      actorId: parsed.userId,
      action: "product.update",
      entityType: "product",
      entityId: updated.id,
      before,
      after,
    });

    return updated;
  });
}

const addVariantSchema = z.object({
  productId: z.uuid(),
  userId: z.uuid(),
  // Sem costCents: custo é responsabilidade do serviço de pricing.
  sku: z.string().trim().min(1, "Informe o SKU da variação."),
  attributes: z.record(z.string(), z.string()).default({}),
  barcodeEan: z.string().trim().min(1).optional(),
  weightGrams: z.number().int().positive().optional(),
  lengthMm: z.number().int().positive().optional(),
  widthMm: z.number().int().positive().optional(),
  heightMm: z.number().int().positive().optional(),
});

export type AddVariantInput = z.input<typeof addVariantSchema>;

export async function addVariant(db: ServiceDb, input: AddVariantInput) {
  const parsed = addVariantSchema.parse(input);
  try {
    return await db.transaction(async (tx) => {
      await requireProduct(tx, parsed.productId);
      const [variant] = await tx
        .insert(productVariants)
        .values({
          productId: parsed.productId,
          sku: parsed.sku,
          attributes: parsed.attributes,
          barcodeEan: parsed.barcodeEan ?? null,
          weightGrams: parsed.weightGrams ?? null,
          lengthMm: parsed.lengthMm ?? null,
          widthMm: parsed.widthMm ?? null,
          heightMm: parsed.heightMm ?? null,
        })
        .returning();
      await tx.insert(stockLevels).values({
        productVariantId: variant.id,
        onHand: 0,
        reserved: 0,
      });
      await writeAudit(tx, {
        actorId: parsed.userId,
        action: "variant.create",
        entityType: "product_variant",
        entityId: variant.id,
        after: { productId: parsed.productId, sku: variant.sku, attributes: parsed.attributes },
      });
      return variant;
    });
  } catch (error) {
    throw mapCatalogUniqueViolation(error) ?? error;
  }
}

const updateVariantSchema = z.object({
  variantId: z.uuid(),
  userId: z.uuid(),
  // Sem sku (imutável após criação) e sem costCents (serviço de pricing).
  attributes: z.record(z.string(), z.string()).optional(),
  barcodeEan: z.string().trim().min(1).nullable().optional(),
  weightGrams: z.number().int().positive().nullable().optional(),
  lengthMm: z.number().int().positive().nullable().optional(),
  widthMm: z.number().int().positive().nullable().optional(),
  heightMm: z.number().int().positive().nullable().optional(),
  isActive: z.boolean().optional(),
});

export type UpdateVariantInput = z.input<typeof updateVariantSchema>;

export async function updateVariant(db: ServiceDb, input: UpdateVariantInput) {
  const parsed = updateVariantSchema.parse(input);
  try {
    return await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(productVariants)
        .where(
          and(
            eq(productVariants.id, parsed.variantId),
            isNull(productVariants.deletedAt),
          ),
        )
        .limit(1);
      if (!current) {
        throw new ServiceError("nao_encontrado", "Variação não encontrada.");
      }

      const patch: Partial<typeof current> = {};
      if (parsed.attributes !== undefined) patch.attributes = parsed.attributes;
      if (parsed.barcodeEan !== undefined) patch.barcodeEan = parsed.barcodeEan;
      if (parsed.weightGrams !== undefined) patch.weightGrams = parsed.weightGrams;
      if (parsed.lengthMm !== undefined) patch.lengthMm = parsed.lengthMm;
      if (parsed.widthMm !== undefined) patch.widthMm = parsed.widthMm;
      if (parsed.heightMm !== undefined) patch.heightMm = parsed.heightMm;
      if (parsed.isActive !== undefined) patch.isActive = parsed.isActive;
      if (Object.keys(patch).length === 0) return current;

      const [updated] = await tx
        .update(productVariants)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(productVariants.id, parsed.variantId))
        .returning();

      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const key of Object.keys(patch) as (keyof typeof patch)[]) {
        before[key] = current[key];
        after[key] = updated[key];
      }
      await writeAudit(tx, {
        actorId: parsed.userId,
        action: "variant.update",
        entityType: "product_variant",
        entityId: updated.id,
        before,
        after,
      });

      return updated;
    });
  } catch (error) {
    throw mapCatalogUniqueViolation(error) ?? error;
  }
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

const listProductsSchema = z.object({
  search: z.string().trim().min(1).optional(),
  status: z.enum(["draft", "active", "archived"]).optional(),
});

export type ListProductsInput = z.input<typeof listProductsSchema>;

export type ProductListItem = {
  id: string;
  name: string;
  slug: string;
  status: string;
  brand: string | null;
  variantCount: number;
  minActivePriceCents: number | null;
  maxActivePriceCents: number | null;
  totalOnHand: number;
  totalReserved: number;
};

export async function listProducts(
  db: ServiceDb,
  input: ListProductsInput = {},
): Promise<ProductListItem[]> {
  const parsed = listProductsSchema.parse(input);

  const filters = [isNull(products.deletedAt)];
  if (parsed.status) filters.push(eq(products.status, parsed.status));
  if (parsed.search) {
    const pattern = `%${parsed.search}%`;
    filters.push(
      or(
        ilike(products.name, pattern),
        ilike(products.brand, pattern),
        sql`exists (
          select 1 from product_variants pv
          where pv.product_id = ${products.id}
            and pv.sku ilike ${pattern}
            and pv.deleted_at is null
        )`,
      )!,
    );
  }

  const rows = await db
    .select({
      id: products.id,
      name: products.name,
      slug: products.slug,
      status: products.status,
      brand: products.brand,
      variantCount: sql<string>`count(distinct ${productVariants.id})`,
      minActivePriceCents: sql<string | null>`min(${priceVersions.priceCents})`,
      maxActivePriceCents: sql<string | null>`max(${priceVersions.priceCents})`,
      totalOnHand: sql<string>`coalesce(sum(${stockLevels.onHand}), 0)`,
      totalReserved: sql<string>`coalesce(sum(${stockLevels.reserved}), 0)`,
    })
    .from(products)
    .leftJoin(
      productVariants,
      and(
        eq(productVariants.productId, products.id),
        isNull(productVariants.deletedAt),
      ),
    )
    .leftJoin(stockLevels, eq(stockLevels.productVariantId, productVariants.id))
    .leftJoin(
      priceVersions,
      and(
        eq(priceVersions.productVariantId, productVariants.id),
        eq(priceVersions.status, "active"),
      ),
    )
    .where(and(...filters))
    .groupBy(products.id)
    .orderBy(products.name);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    brand: row.brand,
    variantCount: Number(row.variantCount),
    minActivePriceCents:
      row.minActivePriceCents === null ? null : Number(row.minActivePriceCents),
    maxActivePriceCents:
      row.maxActivePriceCents === null ? null : Number(row.maxActivePriceCents),
    totalOnHand: Number(row.totalOnHand),
    totalReserved: Number(row.totalReserved),
  }));
}

export async function getProductDetail(db: ServiceDb, productId: string) {
  const parsedId = z.uuid().parse(productId);
  const product = await requireProduct(db, parsedId);

  const variantRows = await db
    .select({
      variant: productVariants,
      stock: stockLevels,
      activePrice: {
        id: priceVersions.id,
        priceCents: priceVersions.priceCents,
        versionNumber: priceVersions.versionNumber,
        computedMarginRate: priceVersions.computedMarginRate,
      },
    })
    .from(productVariants)
    .leftJoin(stockLevels, eq(stockLevels.productVariantId, productVariants.id))
    .leftJoin(
      priceVersions,
      and(
        eq(priceVersions.productVariantId, productVariants.id),
        eq(priceVersions.status, "active"),
      ),
    )
    .where(
      and(
        eq(productVariants.productId, parsedId),
        isNull(productVariants.deletedAt),
      ),
    )
    .orderBy(productVariants.createdAt);

  const images = await db
    // Projeção explícita: a tela de produto do painel depende deste formato,
    // inclusive de `color` (null = foto do produto inteiro).
    .select({
      id: productImages.id,
      productId: productImages.productId,
      variantId: productImages.variantId,
      storagePath: productImages.storagePath,
      altText: productImages.altText,
      color: productImages.color,
      sortOrder: productImages.sortOrder,
      createdAt: productImages.createdAt,
    })
    .from(productImages)
    .where(eq(productImages.productId, parsedId))
    .orderBy(productImages.sortOrder, productImages.createdAt);

  return {
    ...product,
    variants: variantRows.map((row) => {
      const onHand = row.stock?.onHand ?? 0;
      const reserved = row.stock?.reserved ?? 0;
      return {
        id: row.variant.id,
        sku: row.variant.sku,
        attributes: (row.variant.attributes ?? {}) as Record<string, string>,
        barcodeEan: row.variant.barcodeEan,
        weightGrams: row.variant.weightGrams,
        isActive: row.variant.isActive,
        costCents: row.variant.costCents,
        onHand,
        reserved,
        available: onHand - reserved,
        lowStockThreshold: row.stock?.lowStockThreshold ?? null,
        activePriceCents: row.activePrice?.priceCents ?? null,
        activePriceVersionId: row.activePrice?.id ?? null,
        // numeric(7,4) chega como string do driver.
        activeMarginRate:
          row.activePrice?.computedMarginRate != null
            ? Number(row.activePrice.computedMarginRate)
            : null,
      };
    }),
    images,
  };
}

// ---------------------------------------------------------------------------
// Imagens
// ---------------------------------------------------------------------------

const FULL_SUFFIX = "-full.webp";
const MD_SUFFIX = "-md.webp";
const THUMB_SUFFIX = "-thumb.webp";

/** Larguras das rendições geradas no upload (a vitrine escolhe via srcset). */
export const IMAGE_RENDITIONS = {
  full: 1600,
  md: 800,
  thumb: 400,
} as const;

/** Deriva por convenção o path do thumbnail a partir do path gravado (-full). */
export function thumbPathFor(storagePath: string): string {
  return storagePath.replace(/-full\.webp$/, THUMB_SUFFIX);
}

/** Deriva por convenção o path da rendição média (800w) a partir do -full. */
export function mdPathFor(storagePath: string): string {
  return storagePath.replace(/-full\.webp$/, MD_SUFFIX);
}

/** Converte a imagem enviada para webp na largura pedida (sem upscale, com EXIF). */
export async function renderWebp(source: Buffer, width: number): Promise<Buffer> {
  return sharp(source)
    .rotate()
    .resize({ width, withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();
}

/**
 * Normaliza a cor da foto e recusa cor que nenhuma variação tem — foto etiquetada
 * com uma cor inexistente sumiria da vitrine sem ninguém entender por quê.
 * Produto sem eixo de cor não passa por essa conferência: a etiqueta é livre.
 */
async function resolveImageColor(
  db: ServiceDb,
  product: { id: string; attributesSchema: unknown },
  rawColor: string | null | undefined,
): Promise<string | null> {
  const color = rawColor ? normalizeAxisValue(rawColor) : null;
  const colorAxis = findColorAxis(product.attributesSchema);
  if (!color || !colorAxis) return color;

  const rows = await db
    .select({ attributes: productVariants.attributes })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.productId, product.id),
        isNull(productVariants.deletedAt),
      ),
    );
  const known = rows.some(
    (row) =>
      ((row.attributes ?? {}) as Record<string, string>)[colorAxis] === color,
  );
  if (!known) {
    throw new ServiceError(
      "cor_invalida",
      `Nenhuma variação deste produto tem a cor "${color}". Cadastre a variação antes de usar esta cor na foto.`,
    );
  }
  return color;
}

const addProductImageSchema = z.object({
  productId: z.uuid(),
  variantId: z.uuid().optional(),
  // z.custom com o tipo largo (ArrayBufferLike) para aceitar Buffer do Node.
  data: z.custom<Uint8Array | Buffer>(
    (value) => value instanceof Uint8Array,
    "Dados da imagem ausentes ou inválidos.",
  ),
  contentType: z.string().min(1),
  altText: z.string().trim().min(1).optional(),
  // Cor a que a foto pertence; ausente = foto do produto inteiro.
  color: z.string().trim().min(1).optional(),
  userId: z.uuid(),
});

export type AddProductImageInput = z.input<typeof addProductImageSchema>;

export async function addProductImage(
  db: ServiceDb,
  storage: FileStorage,
  input: AddProductImageInput,
) {
  const parsed = addProductImageSchema.parse(input);
  if (!parsed.contentType.startsWith("image/")) {
    throw new ServiceError(
      "imagem_invalida",
      "O arquivo enviado não é uma imagem.",
    );
  }

  const product = await requireProduct(db, parsed.productId);
  if (parsed.variantId) {
    const [variant] = await db
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(
        and(
          eq(productVariants.id, parsed.variantId),
          eq(productVariants.productId, parsed.productId),
          isNull(productVariants.deletedAt),
        ),
      )
      .limit(1);
    if (!variant) {
      throw new ServiceError(
        "nao_encontrado",
        "Variação não encontrada para este produto.",
      );
    }
  }

  // Toda validação acontece antes do upload: recusa não deixa arquivo órfão.
  const color = await resolveImageColor(db, product, parsed.color);

  const source = Buffer.isBuffer(parsed.data)
    ? parsed.data
    : Buffer.from(parsed.data);

  let fullBuffer: Buffer;
  let mdBuffer: Buffer;
  let thumbBuffer: Buffer;
  try {
    // Três rendições: full (desktop/2×), md (celular) e thumb (cards).
    fullBuffer = await renderWebp(source, IMAGE_RENDITIONS.full);
    mdBuffer = await renderWebp(source, IMAGE_RENDITIONS.md);
    thumbBuffer = await renderWebp(source, IMAGE_RENDITIONS.thumb);
  } catch {
    throw new ServiceError(
      "imagem_invalida",
      "Não foi possível processar a imagem. Verifique se o arquivo é uma imagem válida.",
    );
  }

  const basePath = `products/${parsed.productId}/${randomUUID()}`;
  const fullPath = `${basePath}${FULL_SUFFIX}`;
  const mdPath = `${basePath}${MD_SUFFIX}`;
  const thumbPath = `${basePath}${THUMB_SUFFIX}`;

  // Upload antes do INSERT: a linha só existe se os arquivos existirem.
  await storage.upload({ path: fullPath, data: fullBuffer, contentType: "image/webp" });
  await storage.upload({ path: mdPath, data: mdBuffer, contentType: "image/webp" });
  await storage.upload({ path: thumbPath, data: thumbBuffer, contentType: "image/webp" });

  const image = await db.transaction(async (tx) => {
    const [{ nextSortOrder }] = await tx
      .select({
        nextSortOrder: sql<string>`coalesce(max(${productImages.sortOrder}), -1) + 1`,
      })
      .from(productImages)
      .where(eq(productImages.productId, parsed.productId));

    const [row] = await tx
      .insert(productImages)
      .values({
        productId: parsed.productId,
        variantId: parsed.variantId ?? null,
        storagePath: fullPath,
        altText: parsed.altText ?? null,
        color,
        sortOrder: Number(nextSortOrder),
      })
      .returning();

    await writeAudit(tx, {
      actorId: parsed.userId,
      action: "product_image.create",
      entityType: "product_image",
      entityId: row.id,
      after: {
        productId: parsed.productId,
        variantId: parsed.variantId ?? null,
        storagePath: fullPath,
        color,
      },
    });

    return row;
  });

  return {
    ...image,
    thumbPath,
    mdPath,
    fullUrl: storage.publicUrl(fullPath),
    mdUrl: storage.publicUrl(mdPath),
    thumbUrl: storage.publicUrl(thumbPath),
  };
}

const setProductImageColorSchema = z.object({
  imageId: z.uuid(),
  /** null = foto do produto inteiro: aparece em qualquer cor escolhida. */
  color: z.string().trim().min(1).nullable(),
  userId: z.uuid(),
});

export type SetProductImageColorInput = z.input<
  typeof setProductImageColorSchema
>;

/** Reetiqueta uma foto já enviada: define, troca ou tira a cor a que ela pertence. */
export async function setProductImageColor(
  db: ServiceDb,
  input: SetProductImageColorInput,
) {
  const parsed = setProductImageColorSchema.parse(input);

  const [image] = await db
    .select()
    .from(productImages)
    .where(eq(productImages.id, parsed.imageId))
    .limit(1);
  if (!image) {
    throw new ServiceError("nao_encontrado", "Imagem não encontrada.");
  }

  const product = await requireProduct(db, image.productId);
  const color = await resolveImageColor(db, product, parsed.color);
  if (color === image.color) return image;

  return await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(productImages)
      .set({ color })
      .where(eq(productImages.id, parsed.imageId))
      .returning();

    await writeAudit(tx, {
      actorId: parsed.userId,
      action: "product_image.set_color",
      entityType: "product_image",
      entityId: updated.id,
      before: { color: image.color },
      after: { color: updated.color },
    });

    return updated;
  });
}

const removeProductImageSchema = z.object({
  imageId: z.uuid(),
  userId: z.uuid(),
});

export type RemoveProductImageInput = z.input<typeof removeProductImageSchema>;

export async function removeProductImage(
  db: ServiceDb,
  storage: FileStorage,
  input: RemoveProductImageInput,
) {
  const parsed = removeProductImageSchema.parse(input);

  const image = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(productImages)
      .where(eq(productImages.id, parsed.imageId))
      .limit(1);
    if (!row) {
      throw new ServiceError("nao_encontrado", "Imagem não encontrada.");
    }
    await tx.delete(productImages).where(eq(productImages.id, parsed.imageId));
    await writeAudit(tx, {
      actorId: parsed.userId,
      action: "product_image.delete",
      entityType: "product_image",
      entityId: row.id,
      before: { productId: row.productId, storagePath: row.storagePath },
    });
    return row;
  });

  await storage.remove(image.storagePath);
  await storage.remove(mdPathFor(image.storagePath));
  await storage.remove(thumbPathFor(image.storagePath));
}
