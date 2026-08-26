// Serviço de fornecedores: cadastro e consultas (receita do módulo clientes).
import { and, desc, eq, ilike, isNull, like, or } from "drizzle-orm";
import { z } from "zod";

import {
  auditLog,
  financialEntries,
  products,
  productVariants,
  stockMovements,
  suppliers,
} from "@/db/schema";
import { normalizeDocument } from "@/lib/document";
import { toE164BR } from "@/lib/phone";
import { ServiceError, type ServiceDb } from "./catalog";

// ---------------------------------------------------------------------------
// Erros e helpers
// ---------------------------------------------------------------------------

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

function mapSupplierUniqueViolation(error: unknown): ServiceError | null {
  const text = errorChainText(error);
  if (text.includes("suppliers_email_unique_idx")) {
    return new ServiceError(
      "email_duplicado",
      "Já existe um fornecedor com este e-mail.",
    );
  }
  if (text.includes("suppliers_phone_e164_unique_idx")) {
    return new ServiceError(
      "telefone_duplicado",
      "Já existe um fornecedor com este telefone.",
    );
  }
  if (text.includes("suppliers_document_number_unique_idx")) {
    return new ServiceError(
      "documento_duplicado",
      "Já existe um fornecedor com este CPF/CNPJ.",
    );
  }
  return null;
}

function normalizePhoneOrThrow(phone: string): string {
  const normalized = toE164BR(phone);
  if (!normalized) {
    throw new ServiceError(
      "telefone_invalido",
      "Telefone inválido. Informe DDD + número, ex.: (11) 99999-8888.",
    );
  }
  return normalized;
}

function normalizeDocumentOrThrow(document: string): {
  type: "cpf" | "cnpj";
  digits: string;
} {
  const normalized = normalizeDocument(document);
  if (!normalized) {
    throw new ServiceError(
      "documento_invalido",
      "CPF/CNPJ inválido. Confira os dígitos informados.",
    );
  }
  return normalized;
}

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

async function requireSupplier(db: ServiceDb, supplierId: string) {
  const [supplier] = await db
    .select()
    .from(suppliers)
    .where(and(eq(suppliers.id, supplierId), isNull(suppliers.deletedAt)))
    .limit(1);
  if (!supplier) {
    throw new ServiceError("nao_encontrado", "Fornecedor não encontrado.");
  }
  return supplier;
}

// ---------------------------------------------------------------------------
// Cadastro
// ---------------------------------------------------------------------------

const createSupplierSchema = z.object({
  name: z.string().trim().min(1, "Informe o nome do fornecedor."),
  contactName: z.string().trim().min(1).optional(),
  email: z.email("E-mail inválido.").optional(),
  phone: z.string().trim().min(1).optional(),
  document: z.string().trim().min(1).optional(),
  pixKey: z.string().trim().min(1).max(140).optional(),
  notes: z.string().optional(),
  userId: z.uuid(),
});

export type CreateSupplierInput = z.input<typeof createSupplierSchema>;

export async function createSupplier(db: ServiceDb, input: CreateSupplierInput) {
  const parsed = createSupplierSchema.parse(input);

  const phoneE164 = parsed.phone ? normalizePhoneOrThrow(parsed.phone) : null;
  const document = parsed.document
    ? normalizeDocumentOrThrow(parsed.document)
    : null;

  try {
    return await db.transaction(async (tx) => {
      const [supplier] = await tx
        .insert(suppliers)
        .values({
          name: parsed.name,
          contactName: parsed.contactName ?? null,
          email: parsed.email?.toLowerCase() ?? null,
          phoneE164,
          documentType: document?.type ?? null,
          documentNumber: document?.digits ?? null,
          pixKey: parsed.pixKey ?? null,
          notes: parsed.notes ?? null,
        })
        .returning();

      await writeAudit(tx, {
        actorId: parsed.userId,
        action: "supplier.create",
        entityType: "supplier",
        entityId: supplier.id,
        after: {
          name: supplier.name,
          email: supplier.email,
          phoneE164: supplier.phoneE164,
          documentType: supplier.documentType,
        },
      });

      return supplier;
    });
  } catch (error) {
    throw mapSupplierUniqueViolation(error) ?? error;
  }
}

const updateSupplierSchema = z.object({
  supplierId: z.uuid(),
  userId: z.uuid(),
  name: z.string().trim().min(1).optional(),
  contactName: z.string().trim().min(1).nullable().optional(),
  email: z.email("E-mail inválido.").nullable().optional(),
  phone: z.string().trim().min(1).nullable().optional(),
  document: z.string().trim().min(1).nullable().optional(),
  pixKey: z.string().trim().min(1).max(140).nullable().optional(),
  notes: z.string().nullable().optional(),
});

export type UpdateSupplierInput = z.input<typeof updateSupplierSchema>;

export async function updateSupplier(db: ServiceDb, input: UpdateSupplierInput) {
  const parsed = updateSupplierSchema.parse(input);

  try {
    return await db.transaction(async (tx) => {
      const current = await requireSupplier(tx, parsed.supplierId);

      const patch: Partial<typeof current> = {};
      if (parsed.name !== undefined) patch.name = parsed.name;
      if (parsed.contactName !== undefined) {
        patch.contactName = parsed.contactName;
      }
      if (parsed.email !== undefined) {
        patch.email = parsed.email?.toLowerCase() ?? null;
      }
      if (parsed.phone !== undefined) {
        patch.phoneE164 =
          parsed.phone === null ? null : normalizePhoneOrThrow(parsed.phone);
      }
      if (parsed.document !== undefined) {
        if (parsed.document === null) {
          patch.documentType = null;
          patch.documentNumber = null;
        } else {
          const document = normalizeDocumentOrThrow(parsed.document);
          patch.documentType = document.type;
          patch.documentNumber = document.digits;
        }
      }
      if (parsed.pixKey !== undefined) patch.pixKey = parsed.pixKey;
      if (parsed.notes !== undefined) patch.notes = parsed.notes;
      if (Object.keys(patch).length === 0) return current;

      const [updated] = await tx
        .update(suppliers)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(suppliers.id, parsed.supplierId))
        .returning();

      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const key of Object.keys(patch) as (keyof typeof patch)[]) {
        before[key] = current[key];
        after[key] = updated[key];
      }
      await writeAudit(tx, {
        actorId: parsed.userId,
        action: "supplier.update",
        entityType: "supplier",
        entityId: updated.id,
        before,
        after,
      });

      return updated;
    });
  } catch (error) {
    throw mapSupplierUniqueViolation(error) ?? error;
  }
}

const deactivateSupplierSchema = z.object({
  supplierId: z.uuid(),
  userId: z.uuid(),
});

export type DeactivateSupplierInput = z.input<typeof deactivateSupplierSchema>;

/**
 * Soft-delete: o fornecedor some das listas e libera e-mail/telefone/documento
 * (índices únicos parciais), mas o histórico de compras e contas permanece.
 */
export async function deactivateSupplier(
  db: ServiceDb,
  input: DeactivateSupplierInput,
) {
  const parsed = deactivateSupplierSchema.parse(input);

  return db.transaction(async (tx) => {
    const current = await requireSupplier(tx, parsed.supplierId);

    const now = new Date();
    const [updated] = await tx
      .update(suppliers)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(suppliers.id, parsed.supplierId))
      .returning();

    await writeAudit(tx, {
      actorId: parsed.userId,
      action: "supplier.deactivate",
      entityType: "supplier",
      entityId: current.id,
      before: { deletedAt: null },
      after: { deletedAt: now.toISOString() },
    });

    return updated;
  });
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

const listSuppliersSchema = z.object({
  search: z.string().trim().min(1).optional(),
});

export type ListSuppliersInput = z.input<typeof listSuppliersSchema>;

export async function listSuppliers(
  db: ServiceDb,
  input: ListSuppliersInput = {},
) {
  const parsed = listSuppliersSchema.parse(input);

  const filters = [isNull(suppliers.deletedAt)];
  if (parsed.search) {
    const pattern = `%${parsed.search}%`;
    const conditions = [
      ilike(suppliers.name, pattern),
      ilike(suppliers.contactName, pattern),
      ilike(suppliers.email, pattern),
    ];
    const digits = parsed.search.replace(/\D/g, "");
    if (digits.length >= 4) {
      conditions.push(like(suppliers.phoneE164, `%${digits}%`));
      conditions.push(like(suppliers.documentNumber, `%${digits}%`));
    }
    filters.push(or(...conditions)!);
  }

  return db
    .select({
      id: suppliers.id,
      name: suppliers.name,
      contactName: suppliers.contactName,
      email: suppliers.email,
      phoneE164: suppliers.phoneE164,
      documentType: suppliers.documentType,
      createdAt: suppliers.createdAt,
    })
    .from(suppliers)
    .where(and(...filters))
    .orderBy(suppliers.name);
}

export async function getSupplierDetail(db: ServiceDb, supplierId: string) {
  const parsedId = z.uuid().parse(supplierId);
  const supplier = await requireSupplier(db, parsedId);

  const linkedProducts = await db
    .select({
      id: products.id,
      name: products.name,
      status: products.status,
    })
    .from(products)
    .where(and(eq(products.supplierId, parsedId), isNull(products.deletedAt)))
    .orderBy(products.name);

  const recentPurchases = await db
    .select({
      id: stockMovements.id,
      variantId: stockMovements.productVariantId,
      sku: productVariants.sku,
      productName: products.name,
      quantity: stockMovements.quantityDelta,
      unitCostCents: stockMovements.unitCostCents,
      note: stockMovements.note,
      createdAt: stockMovements.createdAt,
    })
    .from(stockMovements)
    .innerJoin(
      productVariants,
      eq(productVariants.id, stockMovements.productVariantId),
    )
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(
      and(
        eq(stockMovements.referenceType, "supplier"),
        eq(stockMovements.referenceId, parsedId),
      ),
    )
    .orderBy(desc(stockMovements.createdAt), desc(stockMovements.id))
    .limit(10);

  const payables = await db
    .select()
    .from(financialEntries)
    .where(
      and(
        eq(financialEntries.supplierId, parsedId),
        eq(financialEntries.direction, "payable"),
      ),
    )
    .orderBy(desc(financialEntries.createdAt), desc(financialEntries.id))
    .limit(10);

  return { ...supplier, products: linkedProducts, recentPurchases, payables };
}
