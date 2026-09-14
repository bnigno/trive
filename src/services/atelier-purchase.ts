// A chegada vira compra: o fornecedor do recado (achado pelo nome ou criado
// na hora), a quantidade dita em cada variação como entrada de estoque com
// custo, e UMA conta a pagar pelo total — tudo idempotente por chegada. Sem
// quantidade não há compra (a dona lança pelo painel); sem fornecedor só o
// estoque entra. Nada aqui derruba a chegada: o que falhar fica anotado.
import { and, asc, eq, isNull } from "drizzle-orm";

import type { ArrivalProposal } from "@/core/atelier/proposal";
import { purchaseDescription, purchaseLinesFromVariants } from "@/core/atelier/purchase";
import { atelierIntakes, productVariants } from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { updateProduct, type ServiceDb } from "@/services/catalog";
import { receivePurchaseBatch } from "@/services/stock";
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
  /** O que deu errado no meio (fornecedor, compra) sem derrubar a chegada. */
  error: string | null;
};

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
    error: null,
  };
  const { proposal } = input;
  if (!proposal) {
    result.skipped = "sem_proposta";
    return result;
  }

  // O fornecedor do recado: liga na chegada e na ficha mesmo sem quantidade.
  if (!result.supplierId && proposal.supplierName) {
    try {
      const supplier = await findOrCreateSupplierByName(db as unknown as ServiceDb, { name: proposal.supplierName, userId: input.userId });
      if (supplier && "ambiguous" in supplier) {
        result.error = `fornecedor "${proposal.supplierName}" é ambíguo (${supplier.ambiguous.join(", ")}): escolha na ficha`;
      } else if (supplier) {
        result.supplierId = supplier.id;
        result.supplierName = supplier.name;
        result.supplierCreated = supplier.created;
      }
    } catch (error) {
      result.error = `fornecedor: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (result.supplierId) {
    try {
      await updateProduct(db as unknown as ServiceDb, { productId: input.productId, supplierId: result.supplierId, userId: input.userId });
    } catch (error) {
      result.error = [result.error, `ficha: ${error instanceof Error ? error.message : String(error)}`].filter(Boolean).join("; ");
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
    const batch = await receivePurchaseBatch(db, {
      lines: plan.lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity, unitCostCents: line.unitCostCents })),
      supplierId: result.supplierId,
      description: purchaseDescription({ productName: input.productName, totalQuantity: plan.totalQuantity, supplierName: result.supplierName }),
      idempotencyPrefix: `atelier:${input.intakeId}`,
      // O total dito é o que ela pagou: vale mais que peça × custo arredondado.
      ...(proposal.costBasis === "total" && proposal.totalCostCents !== null ? { amountCents: proposal.totalCostCents } : {}),
      note: "Ateliê pelo WhatsApp",
      userId: input.userId,
    });
    result.movements = batch.movementIds.length;
    result.financialEntryId = batch.financialEntryId ?? result.financialEntryId;
    result.payableCents = batch.financialEntryId || result.financialEntryId ? batch.amountCents : null;
  } catch (error) {
    result.error = [result.error, `compra: ${error instanceof Error ? error.message : String(error)}`].filter(Boolean).join("; ");
  }

  await db
    .update(atelierIntakes)
    .set({ supplierId: result.supplierId, financialEntryId: result.financialEntryId, updatedAt: input.now() })
    .where(eq(atelierIntakes.id, input.intakeId));
  return result;
}
