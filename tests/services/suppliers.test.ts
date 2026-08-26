import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import {
  createSupplier,
  deactivateSupplier,
  getSupplierDetail,
  listSuppliers,
  updateSupplier,
} from "@/services/suppliers";
import {
  createTestDb,
  createTestVariant,
  FIXED_USER_ID,
  type TestDb,
} from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  await close();
});

describe("createSupplier", () => {
  it("normalizes phone to E.164, document to bare digits and stores pixKey", async () => {
    const supplier = await createSupplier(db, {
      name: "Ateliê Pedras do Sul",
      contactName: "Carlos",
      email: "Vendas@Atelie.com",
      phone: "(11) 99999-8888",
      document: "11.222.333/0001-81",
      pixKey: "vendas@atelie.com",
      userId: FIXED_USER_ID,
    });

    expect(supplier.phoneE164).toBe("+5511999998888");
    expect(supplier.email).toBe("vendas@atelie.com");
    expect(supplier.documentType).toBe("cnpj");
    expect(supplier.documentNumber).toBe("11222333000181");
    expect(supplier.pixKey).toBe("vendas@atelie.com");

    const audits = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "supplier.create"));
    expect(audits).toHaveLength(1);
    expect(audits[0].entityId).toBe(supplier.id);
  });

  it("rejects invalid phone with pt-BR message", async () => {
    await expect(
      createSupplier(db, {
        name: "Fornecedor",
        phone: "99999-8888",
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow("Telefone inválido");
  });

  it("rejects invalid document with pt-BR message", async () => {
    await expect(
      createSupplier(db, {
        name: "Fornecedor",
        document: "529.982.247-26",
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow("CPF/CNPJ inválido");
  });

  it("maps duplicated email to a friendly message", async () => {
    await createSupplier(db, {
      name: "A",
      email: "compras@exemplo.com",
      userId: FIXED_USER_ID,
    });
    await expect(
      createSupplier(db, {
        name: "B",
        email: "COMPRAS@exemplo.com",
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow("Já existe um fornecedor com este e-mail.");
  });

  it("maps duplicated phone to a friendly message", async () => {
    await createSupplier(db, {
      name: "A",
      phone: "11 98888-7777",
      userId: FIXED_USER_ID,
    });
    await expect(
      createSupplier(db, {
        name: "B",
        phone: "(11) 98888-7777",
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow("Já existe um fornecedor com este telefone.");
  });

  it("maps duplicated document to a friendly message", async () => {
    await createSupplier(db, {
      name: "A",
      document: "529.982.247-25",
      userId: FIXED_USER_ID,
    });
    await expect(
      createSupplier(db, {
        name: "B",
        document: "52998224725",
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow("Já existe um fornecedor com este CPF/CNPJ.");
  });
});

describe("updateSupplier", () => {
  it("re-normalizes phone, clears document with null and audits before/after", async () => {
    const supplier = await createSupplier(db, {
      name: "Fornecedor X",
      phone: "11 97777-1111",
      document: "529.982.247-25",
      userId: FIXED_USER_ID,
    });

    const updated = await updateSupplier(db, {
      supplierId: supplier.id,
      phone: "(21) 96666-2222",
      document: null,
      userId: FIXED_USER_ID,
    });
    expect(updated.phoneE164).toBe("+5521966662222");
    expect(updated.documentType).toBeNull();
    expect(updated.documentNumber).toBeNull();

    const audits = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "supplier.update"));
    expect(audits).toHaveLength(1);
    expect(audits[0].before).toMatchObject({ phoneE164: "+5511977771111" });
    expect(audits[0].after).toMatchObject({ phoneE164: "+5521966662222" });
  });
});

describe("deactivateSupplier", () => {
  it("soft-deletes, hides from list, audits and frees unique data", async () => {
    const supplier = await createSupplier(db, {
      name: "Fornecedor Y",
      phone: "11 95555-4444",
      userId: FIXED_USER_ID,
    });

    await deactivateSupplier(db, {
      supplierId: supplier.id,
      userId: FIXED_USER_ID,
    });

    const [row] = await db
      .select()
      .from(schema.suppliers)
      .where(eq(schema.suppliers.id, supplier.id));
    expect(row.deletedAt).not.toBeNull();

    expect(await listSuppliers(db)).toHaveLength(0);
    await expect(
      getSupplierDetail(db, supplier.id),
    ).rejects.toThrow("Fornecedor não encontrado.");

    const audits = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "supplier.deactivate"));
    expect(audits).toHaveLength(1);

    // Índice único parcial: telefone liberado para um novo cadastro.
    const again = await createSupplier(db, {
      name: "Fornecedor Y (novo)",
      phone: "11 95555-4444",
      userId: FIXED_USER_ID,
    });
    expect(again.phoneE164).toBe("+5511955554444");
  });
});

describe("listSuppliers / getSupplierDetail", () => {
  it("searches by name, contact, email and phone digits", async () => {
    await createSupplier(db, {
      name: "Pedras Brasil",
      contactName: "Marina",
      email: "contato@pedras.com",
      phone: "11 95555-3333",
      userId: FIXED_USER_ID,
    });
    await createSupplier(db, {
      name: "Metais Nobres",
      userId: FIXED_USER_ID,
    });

    expect(await listSuppliers(db, { search: "pedras" })).toHaveLength(1);
    expect(await listSuppliers(db, { search: "marina" })).toHaveLength(1);
    expect(await listSuppliers(db, { search: "contato@pedras" })).toHaveLength(1);
    expect(await listSuppliers(db, { search: "95555-3333" })).toHaveLength(1);
    expect(await listSuppliers(db, { search: "inexistente" })).toHaveLength(0);
    expect(await listSuppliers(db)).toHaveLength(2);
  });

  it("returns linked products, recent purchases and payables", async () => {
    const supplier = await createSupplier(db, {
      name: "Fornecedor Completo",
      userId: FIXED_USER_ID,
    });
    const { productId, variantId } = await createTestVariant(db, {
      sku: "SUP-1",
    });
    await db
      .update(schema.products)
      .set({ supplierId: supplier.id })
      .where(eq(schema.products.id, productId));

    // Compra recente: movimento referenciando o fornecedor.
    await db.insert(schema.stockMovements).values({
      productVariantId: variantId,
      type: "purchase_in",
      quantityDelta: 5,
      unitCostCents: 2000,
      referenceType: "supplier",
      referenceId: supplier.id,
      createdBy: FIXED_USER_ID,
    });

    // Conta a pagar vinculada.
    await db.insert(schema.financialEntries).values({
      direction: "payable",
      category: "supplier",
      description: "Compra: 5× SUP-1 — Fornecedor Completo",
      amountCents: 10000,
      status: "pending",
      supplierId: supplier.id,
      createdBy: FIXED_USER_ID,
    });

    const detail = await getSupplierDetail(db, supplier.id);
    expect(detail.name).toBe("Fornecedor Completo");
    expect(detail.products).toHaveLength(1);
    expect(detail.products[0].id).toBe(productId);
    expect(detail.recentPurchases).toHaveLength(1);
    expect(detail.recentPurchases[0]).toMatchObject({
      sku: "SUP-1",
      quantity: 5,
      unitCostCents: 2000,
    });
    expect(detail.payables).toHaveLength(1);
    expect(detail.payables[0].amountCents).toBe(10000);
    expect(detail.payables[0].status).toBe("pending");
  });

  it("throws a friendly error for unknown supplier", async () => {
    await expect(
      getSupplierDetail(db, "00000000-0000-4000-8000-0000000000ff"),
    ).rejects.toThrow("Fornecedor não encontrado.");
  });
});
