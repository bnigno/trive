// A chegada vira compra: o fornecedor do recado (achado pelo nome ou criado
// na hora), a quantidade dita em cada variação como entrada de estoque com
// custo, e UMA conta a pagar pelo total — tudo idempotente por chegada. Sem
// quantidade não há compra (a dona lança pelo painel); sem fornecedor só o
// estoque entra. Erro de negócio fica anotado e não derruba a chegada; erro
// de infraestrutura (banco caiu, deadlock) sobe — a fila tenta de novo e a
// compra não dobra.
import { and, asc, eq, isNull } from "drizzle-orm";
import { ZodError } from "zod";

import type { ArrivalProposal } from "@/core/atelier/proposal";
import { purchaseDescription, purchaseLinesFromVariants } from "@/core/atelier/purchase";
import { atelierIntakes, products, productVariants, suppliers } from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { ServiceError as CatalogServiceError, updateProduct, type ServiceDb } from "@/services/catalog";
import { receivePurchaseBatch, ServiceError as StockServiceError } from "@/services/stock";
import { findOrCreateSupplierByName } from "@/services/suppliers";

export type ArrivalPurchaseResult = {
  supplierId: string | null;
  supplierName: string | null;
  supplierCreated: boolean;
  financialEntryId: string | null;
  payableCents: number | null;
  totalQuantity: number | null;
  movements: number;
  /** Por que o estoque não entrou (a dona lança pelo painel). */
  skipped: "sem_proposta" | "sem_quantidade" | "total_sem_grade" | "sem_variacoes" | null;
  /** Fornecedor/ficha: não ligou (ambíguo, cadastro recusou) — o estoque pode ter entrado mesmo assim. */
  supplierError: string | null;
  /** A compra em si não foi lançada. */
  purchaseError: string | null;
};

function isBusinessError(error: unknown): boolean {
  return error instanceof ZodError || error instanceof CatalogServiceError || error instanceof StockServiceError;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function receiveArrivalPurchase(
  db: DbOrTx,
  input: {
    intakeId: string;
    productId: string;
    productName: string;
    proposal: ArrivalProposal | null;
    /** O que a chegada já tinha de uma tentativa anterior. */
    existing: { supplierId: string | null; financialEntryId: string | null };
    userId: string;
    now: () => Date;
  },
): Promise<ArrivalPurchaseResult> {
  const result: ArrivalPurchaseResult = {
    supplierId: input.existing.supplierId,
    supplierName: null,
    supplierCreated: false,
    financialEntryId: input.existing.financialEntryId,
    payableCents: null,
    totalQuantity: null,
    movements: 0,
    skipped: null,
    supplierError: null,
    purchaseError: null,
  };
  const { proposal } = input;
  if (!proposal) {
    result.skipped = "sem_proposta";
    return result;
  }

  // O fornecedor do recado: liga na chegada e na ficha mesmo sem quantidade.
  if (result.supplierId) {
    const [known] = await db.select({ name: suppliers.name }).from(suppliers).where(eq(suppliers.id, result.supplierId)).limit(1);
    result.supplierName = known?.name ?? null;
  } else if (proposal.supplierName) {
    try {
      const supplier = await findOrCreateSupplierByName(db as unknown as ServiceDb, { name: proposal.supplierName, userId: input.userId });
      if (supplier && "ambiguous" in supplier) {
        result.supplierError = `"${proposal.supplierName}" pode ser ${supplier.ambiguous.join(" ou ")}: escolha o fornecedor na ficha`;
      } else if (supplier) {
        result.supplierId = supplier.id;
        result.supplierName = supplier.name;
        result.supplierCreated = supplier.created;
      }
    } catch (error) {
      if (!isBusinessError(error)) throw error;
      result.supplierError = `fornecedor: ${messageOf(error)}`;
    }
  }
  if (result.supplierId) {
    const [product] = await db.select({ supplierId: products.supplierId }).from(products).where(eq(products.id, input.productId)).limit(1);
    if (product && product.supplierId !== result.supplierId) {
      try {
        await updateProduct(db as unknown as ServiceDb, { productId: input.productId, supplierId: result.supplierId, userId: input.userId });
      } catch (error) {
        if (!isBusinessError(error)) throw error;
        result.supplierError = [result.supplierError, `ficha: ${messageOf(error)}`].filter(Boolean).join("; ");
      }
    }
  }

  const variants = await db
    .select({ id: productVariants.id, sku: productVariants.sku })
    .from(productVariants)
    .where(and(eq(productVariants.productId, input.productId), isNull(productVariants.deletedAt)))
    .orderBy(asc(productVariants.createdAt), asc(productVariants.sku));
  const plan = purchaseLinesFromVariants(variants, proposal);
  if (plan.kind === "none") {
    result.skipped = plan.reason;
    await db
      .update(atelierIntakes)
      .set({ supplierId: result.supplierId, updatedAt: input.now() })
      .where(eq(atelierIntakes.id, input.intakeId));
    return result;
  }

  result.totalQuantity = plan.totalQuantity;
  try {
    // Compra e vínculo com a chegada na MESMA transação: a conta nunca fica
    // órfã de uma chegada que não sabe dela.
    await db.transaction(async (tx) => {
      const batch = await receivePurchaseBatch(tx, {
        lines: plan.lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity, unitCostCents: line.unitCostCents })),
        supplierId: result.supplierId,
        description: purchaseDescription({ productName: input.productName, totalQuantity: plan.totalQuantity, supplierName: result.supplierName }),
        idempotencyPrefix: `atelier:${input.intakeId}`,
        // O total dito é o que ela pagou: vale mais que peça × custo arredondado.
        ...(proposal.costBasis === "total" && proposal.totalCostCents !== null ? { amountCents: proposal.totalCostCents } : {}),
        payableMissing: result.financialEntryId === null,
        note: "Ateliê pelo WhatsApp",
        userId: input.userId,
      });
      result.movements = batch.movementIds.length;
      result.financialEntryId = batch.financialEntryId ?? result.financialEntryId;
      result.payableCents = result.financialEntryId ? batch.amountCents : null;
      await tx
        .update(atelierIntakes)
        .set({ supplierId: result.supplierId, financialEntryId: result.financialEntryId, updatedAt: input.now() })
        .where(eq(atelierIntakes.id, input.intakeId));
    });
  } catch (error) {
    if (!isBusinessError(error)) throw error;
    result.purchaseError = messageOf(error);
    await db
      .update(atelierIntakes)
      .set({ supplierId: result.supplierId, updatedAt: input.now() })
      .where(eq(atelierIntakes.id, input.intakeId));
  }
  return result;
}
