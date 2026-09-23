/**
 * Excluir e restaurar peças do catálogo.
 *
 * Por que não se apaga a linha de verdade: `stock_movements` e `variant_costs`
 * são append-only por trigger (drizzle/0002_fase1_guards.sql) e apontam para a
 * variação com FK RESTRICT. Toda peça cadastrada pelo painel nasce com custo
 * inicial, então toda peça já está atrás desse muro — e derrubá-lo significaria
 * perder a auditoria de custo e estoque, e com ela os relatórios de margem.
 *
 * O que se faz, então: `deleted_at` na peça e nas variações. A coluna já é
 * filtrada em toda parte (vitrine, Lia, estoque, preços, prontidão, painel),
 * então a peça some na hora e pode voltar. As FOTOS, essas sim, são apagadas
 * de verdade — do banco e do Storage —, e é disso que a tela avisa antes.
 */
import { and, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";

import type { FileStorage } from "@/adapters/storage";
import type { DbOrTx } from "@/queue/enqueue";
import {
  auditLog,
  campaignLinks,
  cityEditionProducts,
  cityEditions,
  couponProducts,
  coupons,
  customerLooks,
  dropProducts,
  drops,
  orderItems,
  orders,
  productImages,
  products,
  productVariants,
  stockAlerts,
  stockHolds,
  stockLevels,
} from "@/db/schema";
import {
  mdPathFor,
  ServiceError,
  thumbPathFor,
  type ServiceDb,
} from "@/services/catalog";
import { releaseStockHold } from "@/services/stock-holds";

// ---------------------------------------------------------------------------
// O aviso: o que o dono precisa saber ANTES de excluir
// ---------------------------------------------------------------------------

export type ProductDeletionSummary = {
  productId: string;
  name: string;
  slug: string;
  status: string;
  skus: string[];
  /** Fotos que serão apagadas para sempre (linhas de product_images). */
  photoCount: number;
  /** Peças já vendidas (soma das quantidades em pedidos não cancelados). */
  soldCount: number;
  /** Pedidos ainda em andamento com esta peça. */
  openOrderCount: number;
  /** Saldo em estoque somado das variações. */
  onHand: number;
  /** Reservas gentis ativas, que serão liberadas. */
  activeHolds: number;
  /** Clientes esperando "me avisa quando voltar", que não serão avisadas. */
  waitingAlerts: number;
  /** Frases prontas do que ainda segura a peça ("o lançamento «Primavera»"). */
  linkedTo: string[];
};

/**
 * Só leitura: monta o texto do aviso com números reais. O molde de `linkedTo`
 * é o da limpeza de inauguração (src/services/launch-reset.ts).
 */
export async function describeProductDeletion(
  db: ServiceDb,
  productId: string,
): Promise<ProductDeletionSummary> {
  const [product] = await db
    .select({
      id: products.id,
      name: products.name,
      slug: products.slug,
      status: products.status,
    })
    .from(products)
    .where(and(eq(products.id, productId), isNull(products.deletedAt)))
    .limit(1);
  if (!product) {
    throw new ServiceError("nao_encontrado", "Produto não encontrado.");
  }

  const variants = await db
    .select({ id: productVariants.id, sku: productVariants.sku })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.productId, productId),
        isNull(productVariants.deletedAt),
      ),
    );
  const variantIds = variants.map((variant) => variant.id);

  const [photos] = await db
    .select({ count: sql<string>`count(*)` })
    .from(productImages)
    .where(eq(productImages.productId, productId));

  const empty = variantIds.length === 0;

  const [sold] = empty
    ? [{ units: "0", openOrders: "0" }]
    : await db
        .select({
          units: sql<string>`coalesce(sum(${orderItems.quantity}), 0)`,
          openOrders: sql<string>`count(distinct ${orders.id}) filter (where ${orders.status} not in ('delivered', 'canceled', 'refunded'))`,
        })
        .from(orderItems)
        .innerJoin(orders, eq(orders.id, orderItems.orderId))
        .where(
          and(
            inArray(orderItems.productVariantId, variantIds),
            ne(orders.status, "canceled"),
          ),
        );

  const [stock] = empty
    ? [{ onHand: "0" }]
    : await db
        .select({ onHand: sql<string>`coalesce(sum(${stockLevels.onHand}), 0)` })
        .from(stockLevels)
        .where(inArray(stockLevels.productVariantId, variantIds));

  const [holds] = empty
    ? [{ count: "0" }]
    : await db
        .select({ count: sql<string>`count(*)` })
        .from(stockHolds)
        .where(
          and(
            inArray(stockHolds.productVariantId, variantIds),
            eq(stockHolds.status, "active"),
          ),
        );

  const [alerts] = empty
    ? [{ count: "0" }]
    : await db
        .select({ count: sql<string>`count(*)` })
        .from(stockAlerts)
        .where(
          and(
            inArray(stockAlerts.productVariantId, variantIds),
            isNull(stockAlerts.notifiedAt),
            isNull(stockAlerts.canceledAt),
          ),
        );

  return {
    productId: product.id,
    name: product.name,
    slug: product.slug,
    status: product.status,
    skus: variants.map((variant) => variant.sku),
    photoCount: Number(photos?.count ?? 0),
    soldCount: Number(sold?.units ?? 0),
    openOrderCount: Number(sold?.openOrders ?? 0),
    onHand: Number(stock?.onHand ?? 0),
    activeHolds: Number(holds?.count ?? 0),
    waitingAlerts: Number(alerts?.count ?? 0),
    linkedTo: await describeLinks(db, productId),
  };
}

/** Frases em português do que ainda aponta para a peça. */
async function describeLinks(db: ServiceDb, productId: string): Promise<string[]> {
  const phrases: string[] = [];

  const dropRows = await db
    .select({ name: drops.name })
    .from(dropProducts)
    .innerJoin(drops, eq(drops.id, dropProducts.dropId))
    .where(eq(dropProducts.productId, productId));
  for (const row of dropRows) phrases.push(`o lançamento «${row.name}»`);

  const editionRows = await db
    .select({ name: cityEditions.name })
    .from(cityEditionProducts)
    .innerJoin(cityEditions, eq(cityEditions.id, cityEditionProducts.cityEditionId))
    .where(eq(cityEditionProducts.productId, productId));
  for (const row of editionRows) phrases.push(`a edição «${row.name}»`);

  const linkRows = await db
    .select({ label: campaignLinks.label })
    .from(campaignLinks)
    .where(eq(campaignLinks.productId, productId));
  for (const row of linkRows) phrases.push(`o link de story «${row.label}»`);

  const couponRows = await db
    .select({ code: coupons.code })
    .from(couponProducts)
    .innerJoin(coupons, eq(coupons.id, couponProducts.couponId))
    .where(eq(couponProducts.productId, productId));
  for (const row of couponRows) phrases.push(`o cupom ${row.code}`);

  const [looks] = await db
    .select({ count: sql<string>`count(*)` })
    .from(customerLooks)
    .where(eq(customerLooks.productId, productId));
  const lookCount = Number(looks?.count ?? 0);
  if (lookCount > 0) {
    phrases.push(
      lookCount === 1
        ? "1 foto de cliente em «Quem já vestiu»"
        : `${lookCount} fotos de clientes em «Quem já vestiu»`,
    );
  }

  return phrases;
}

// ---------------------------------------------------------------------------
// Excluir
// ---------------------------------------------------------------------------

const deleteProductSchema = z.object({
  productId: z.uuid(),
  userId: z.uuid(),
});

export type DeleteProductInput = z.input<typeof deleteProductSchema>;

export type DeleteProductResult = {
  /** false quando a peça já estava excluída (chamar de novo não quebra). */
  deleted: boolean;
  name: string;
  photosRemoved: number;
  /** Arquivos que o Storage não quis apagar: a peça já saiu do ar mesmo assim. */
  filesFailed: string[];
};

export async function deleteProduct(
  db: ServiceDb,
  storage: FileStorage,
  input: DeleteProductInput,
): Promise<DeleteProductResult> {
  const parsed = deleteProductSchema.parse(input);

  const outcome = await db.transaction(async (tx) => {
    const [product] = await tx
      .select()
      .from(products)
      .where(eq(products.id, parsed.productId))
      .for("update")
      .limit(1);
    if (!product) {
      throw new ServiceError("nao_encontrado", "Produto não encontrado.");
    }
    if (product.deletedAt !== null) {
      return { deleted: false as const, name: product.name, paths: [] as string[] };
    }

    const variants = await tx
      .select({ id: productVariants.id, sku: productVariants.sku })
      .from(productVariants)
      .where(eq(productVariants.productId, product.id));
    const variantIds = variants.map((variant) => variant.id);

    // Os caminhos do Storage têm de sair ANTES das linhas: apagada a linha, o
    // caminho morre com ela e o arquivo fica órfão no bucket para sempre.
    const images = await tx
      .select({ id: productImages.id, storagePath: productImages.storagePath })
      .from(productImages)
      .where(eq(productImages.productId, product.id));
    const paths = images.flatMap((image) => [
      image.storagePath,
      mdPathFor(image.storagePath),
      thumbPathFor(image.storagePath),
    ]);
    if (product.postCardPath) paths.push(product.postCardPath);

    // Reservas gentis antes de tudo: sem isto o saldo reservado fica preso.
    let holdsReleased = 0;
    if (variantIds.length > 0) {
      const activeHolds = await tx
        .select({ id: stockHolds.id })
        .from(stockHolds)
        .where(
          and(
            inArray(stockHolds.productVariantId, variantIds),
            eq(stockHolds.status, "active"),
          ),
        );
      for (const hold of activeHolds) {
        // Mesmo cast que catalog.ts usa na fila: ServiceDb é a base comum de
        // Db, transação e TestDb; DbOrTx é a variante do driver de produção.
        const released = await releaseStockHold(tx as unknown as DbOrTx, {
          holdId: hold.id,
          reason: "released",
          userId: parsed.userId,
        });
        if (released.released) holdsReleased += 1;
      }
    }

    await tx.delete(productImages).where(eq(productImages.productId, product.id));

    const now = new Date();
    await tx
      .update(products)
      .set({ deletedAt: now, postCardPath: null, updatedAt: now })
      .where(eq(products.id, product.id));
    // O status e o is_active das variações ficam como estão: restaurar tem de
    // devolver a peça do jeito que ela era.
    await tx
      .update(productVariants)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(productVariants.productId, product.id),
          isNull(productVariants.deletedAt),
        ),
      );

    // O que não filtra deleted_at sozinho (mesma receita da limpeza de
    // inauguração, src/services/launch-reset.ts).
    await tx.delete(dropProducts).where(eq(dropProducts.productId, product.id));
    await tx
      .delete(cityEditionProducts)
      .where(eq(cityEditionProducts.productId, product.id));
    await tx
      .update(campaignLinks)
      .set({ productId: null, updatedAt: now })
      .where(eq(campaignLinks.productId, product.id));
    let alertsDropped = 0;
    if (variantIds.length > 0) {
      alertsDropped = (
        await tx
          .delete(stockAlerts)
          .where(inArray(stockAlerts.productVariantId, variantIds))
          .returning({ id: stockAlerts.id })
      ).length;
    }

    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: parsed.userId,
      action: "product.delete",
      entityType: "product",
      entityId: product.id,
      before: {
        name: product.name,
        slug: product.slug,
        status: product.status,
        skus: variants.map((variant) => variant.sku),
        postCardPath: product.postCardPath,
        photoPaths: images.map((image) => image.storagePath),
      },
      after: {
        deletedAt: now.toISOString(),
        photosRemoved: images.length,
        holdsReleased,
        alertsDropped,
      },
    });

    return { deleted: true as const, name: product.name, paths };
  });

  // Depois do commit: o banco JÁ está certo, o que falhar aqui é "sobrou
  // arquivo", nunca "não excluiu". Melhor esforço, como removeCoverFiles.
  const filesFailed: string[] = [];
  for (const path of outcome.paths) {
    try {
      await storage.remove(path);
    } catch (error) {
      filesFailed.push(path);
      console.warn(`Arquivo da peça excluída não removido do storage (${path}).`, error);
    }
  }

  return {
    deleted: outcome.deleted,
    name: outcome.name,
    photosRemoved: outcome.paths.length,
    filesFailed,
  };
}

// ---------------------------------------------------------------------------
// Restaurar
// ---------------------------------------------------------------------------

const restoreProductSchema = z.object({
  productId: z.uuid(),
  userId: z.uuid(),
});

export type RestoreProductInput = z.input<typeof restoreProductSchema>;

/**
 * Devolve a peça como RASCUNHO: ela voltou sem fotos, não pode reaparecer na
 * vitrine sozinha. Endereço e código podem ter sido tomados por um cadastro
 * novo — nesse caso o índice parcial recusa e a mensagem diz o que fazer.
 */
export async function restoreProduct(
  db: ServiceDb,
  input: RestoreProductInput,
): Promise<{ restored: boolean; name: string }> {
  const parsed = restoreProductSchema.parse(input);

  return db.transaction(async (tx) => {
    const [product] = await tx
      .select()
      .from(products)
      .where(eq(products.id, parsed.productId))
      .for("update")
      .limit(1);
    if (!product) {
      throw new ServiceError("nao_encontrado", "Produto não encontrado.");
    }
    if (product.deletedAt === null) {
      return { restored: false, name: product.name };
    }

    await assertSlugFree(tx, product.id, product.slug);
    await assertSkusFree(tx, product.id);

    const now = new Date();
    await tx
      .update(products)
      .set({ deletedAt: null, status: "draft", updatedAt: now })
      .where(eq(products.id, product.id));
    await tx
      .update(productVariants)
      .set({ deletedAt: null, updatedAt: now })
      .where(
        and(
          eq(productVariants.productId, product.id),
          isNotNull(productVariants.deletedAt),
        ),
      );

    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: parsed.userId,
      action: "product.restore",
      entityType: "product",
      entityId: product.id,
      before: { deletedAt: product.deletedAt.toISOString(), status: product.status },
      after: { deletedAt: null, status: "draft" },
    });

    return { restored: true, name: product.name };
  });
}

async function assertSlugFree(
  tx: ServiceDb,
  productId: string,
  slug: string,
): Promise<void> {
  const [holder] = await tx
    .select({ name: products.name })
    .from(products)
    .where(
      and(eq(products.slug, slug), ne(products.id, productId), isNull(products.deletedAt)),
    )
    .limit(1);
  if (holder) {
    throw new ServiceError(
      "slug_duplicado",
      `«${holder.name}» ficou com o endereço desta peça na loja. Renomeie aquela peça antes de restaurar esta.`,
    );
  }
}

async function assertSkusFree(tx: ServiceDb, productId: string): Promise<void> {
  const skus = await tx
    .select({ sku: productVariants.sku })
    .from(productVariants)
    .where(eq(productVariants.productId, productId));
  if (skus.length === 0) return;

  const [holder] = await tx
    .select({ sku: productVariants.sku, productName: products.name })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(
      and(
        inArray(
          sql`lower(${productVariants.sku})`,
          skus.map((row) => row.sku.toLowerCase()),
        ),
        ne(productVariants.productId, productId),
        isNull(productVariants.deletedAt),
      ),
    )
    .limit(1);
  if (holder) {
    throw new ServiceError(
      "sku_duplicado",
      `O código ${holder.sku} já está com «${holder.productName}». Troque o código de lá antes de restaurar esta peça.`,
    );
  }
}
