import { and, desc, eq, getTableColumns, sql } from "drizzle-orm";
import { z } from "zod";

import { auditLog, financialEntries, suppliers } from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { ServiceError } from "@/services/stock";

/** Erro de negócio do financeiro com código estável. */
export class FinancialServiceError extends ServiceError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "FinancialServiceError";
  }
}

const ENTRY_DIRECTIONS = ["receivable", "payable"] as const;
const ENTRY_STATUSES = ["pending", "settled", "canceled"] as const;

// ---------------------------------------------------------------------------
// createManualEntry
// ---------------------------------------------------------------------------

const createManualEntrySchema = z.object({
  direction: z.enum(ENTRY_DIRECTIONS),
  category: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  amountCents: z
    .number()
    .int()
    .positive("Valor do lançamento deve ser maior que zero."),
  dueDate: z.iso.date().optional(),
  supplierId: z.uuid().optional(),
  userId: z.uuid(),
});

export type CreateManualEntryInput = z.input<typeof createManualEntrySchema>;

export async function createManualEntry(
  db: DbOrTx,
  input: CreateManualEntryInput,
): Promise<{ entryId: string }> {
  const parsed = createManualEntrySchema.parse(input);

  return db.transaction(async (tx) => {
    const [entry] = await tx
      .insert(financialEntries)
      .values({
        direction: parsed.direction,
        category: parsed.category,
        description: parsed.description,
        amountCents: parsed.amountCents,
        status: "pending",
        dueDate: parsed.dueDate ?? null,
        supplierId: parsed.supplierId ?? null,
        createdBy: parsed.userId,
      })
      .returning({ id: financialEntries.id });

    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: parsed.userId,
      action: "financial_entry.create",
      entityType: "financial_entry",
      entityId: entry.id,
      after: {
        direction: parsed.direction,
        category: parsed.category,
        description: parsed.description,
        amountCents: parsed.amountCents,
        status: "pending",
        dueDate: parsed.dueDate ?? null,
        supplierId: parsed.supplierId ?? null,
      },
    });

    return { entryId: entry.id };
  });
}

// ---------------------------------------------------------------------------
// settleEntry
// ---------------------------------------------------------------------------

const settleEntrySchema = z.object({
  entryId: z.uuid(),
  userId: z.uuid(),
});

export type SettleEntryInput = z.input<typeof settleEntrySchema>;

export async function settleEntry(
  db: DbOrTx,
  input: SettleEntryInput,
): Promise<{ entryId: string; settledAt: Date }> {
  const parsed = settleEntrySchema.parse(input);

  return db.transaction(async (tx) => {
    const [entry] = await tx
      .select()
      .from(financialEntries)
      .where(eq(financialEntries.id, parsed.entryId))
      .for("update");
    if (!entry) {
      throw new FinancialServiceError(
        "ENTRY_NOT_FOUND",
        "Lançamento financeiro não encontrado.",
      );
    }
    if (entry.status !== "pending") {
      throw new FinancialServiceError(
        "ENTRY_NOT_PENDING",
        "Apenas lançamentos pendentes podem ser liquidados.",
      );
    }

    const now = new Date();
    await tx
      .update(financialEntries)
      .set({ status: "settled", settledAt: now, updatedAt: now })
      .where(eq(financialEntries.id, entry.id));

    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: parsed.userId,
      action: "financial_entry.settle",
      entityType: "financial_entry",
      entityId: entry.id,
      before: { status: entry.status },
      after: { status: "settled", settledAt: now.toISOString() },
    });

    return { entryId: entry.id, settledAt: now };
  });
}

// ---------------------------------------------------------------------------
// cancelEntry
// ---------------------------------------------------------------------------

const cancelEntrySchema = z.object({
  entryId: z.uuid(),
  userId: z.uuid(),
  reason: z.string().min(1, "Informe o motivo do cancelamento.").max(2000),
});

export type CancelEntryInput = z.input<typeof cancelEntrySchema>;

export async function cancelEntry(
  db: DbOrTx,
  input: CancelEntryInput,
): Promise<{ entryId: string }> {
  const parsed = cancelEntrySchema.parse(input);

  return db.transaction(async (tx) => {
    const [entry] = await tx
      .select()
      .from(financialEntries)
      .where(eq(financialEntries.id, parsed.entryId))
      .for("update");
    if (!entry) {
      throw new FinancialServiceError(
        "ENTRY_NOT_FOUND",
        "Lançamento financeiro não encontrado.",
      );
    }
    if (entry.status !== "pending") {
      throw new FinancialServiceError(
        "ENTRY_NOT_PENDING",
        "Apenas lançamentos pendentes podem ser cancelados.",
      );
    }

    await tx
      .update(financialEntries)
      .set({ status: "canceled", updatedAt: new Date() })
      .where(eq(financialEntries.id, entry.id));

    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: parsed.userId,
      action: "financial_entry.cancel",
      entityType: "financial_entry",
      entityId: entry.id,
      before: { status: entry.status },
      after: { status: "canceled" },
      reason: parsed.reason,
    });

    return { entryId: entry.id };
  });
}

// ---------------------------------------------------------------------------
// monthOverview
// ---------------------------------------------------------------------------

const monthOverviewSchema = z.object({
  year: z.number().int().min(2000).max(2100),
  month: z.number().int().min(1).max(12),
});

export type MonthOverviewInput = z.input<typeof monthOverviewSchema>;

export interface MonthOverview {
  /** Receivable liquidado no mês (por settled_at). */
  receivedCents: number;
  /** Receivable pendente (carteira aberta, sem recorte de mês). */
  receivableCents: number;
  /** Payable liquidado no mês (por settled_at). */
  paidCents: number;
  /** Payable pendente (carteira aberta, sem recorte de mês). */
  payableCents: number;
  /** recebido - pago no mês. */
  balanceCents: number;
}

export async function monthOverview(
  db: DbOrTx,
  input: MonthOverviewInput,
): Promise<MonthOverview> {
  const parsed = monthOverviewSchema.parse(input);

  // ISO strings (não Date): em sql`` cru o postgres.js não serializa Date.
  const start = new Date(Date.UTC(parsed.year, parsed.month - 1, 1)).toISOString();
  const end = new Date(Date.UTC(parsed.year, parsed.month, 1)).toISOString();

  const settledInMonth = (direction: string) => sql`
    ${financialEntries.direction} = ${direction}
    AND ${financialEntries.status} = 'settled'
    AND ${financialEntries.settledAt} >= ${start}
    AND ${financialEntries.settledAt} < ${end}
  `;
  const pending = (direction: string) => sql`
    ${financialEntries.direction} = ${direction}
    AND ${financialEntries.status} = 'pending'
  `;

  const [row] = await db
    .select({
      receivedCents: sql<
        string | number
      >`coalesce(sum(${financialEntries.amountCents}) filter (where ${settledInMonth("receivable")}), 0)`,
      receivableCents: sql<
        string | number
      >`coalesce(sum(${financialEntries.amountCents}) filter (where ${pending("receivable")}), 0)`,
      paidCents: sql<
        string | number
      >`coalesce(sum(${financialEntries.amountCents}) filter (where ${settledInMonth("payable")}), 0)`,
      payableCents: sql<
        string | number
      >`coalesce(sum(${financialEntries.amountCents}) filter (where ${pending("payable")}), 0)`,
    })
    .from(financialEntries);

  const receivedCents = Number(row.receivedCents);
  const paidCents = Number(row.paidCents);
  return {
    receivedCents,
    receivableCents: Number(row.receivableCents),
    paidCents,
    payableCents: Number(row.payableCents),
    balanceCents: receivedCents - paidCents,
  };
}

// ---------------------------------------------------------------------------
// listEntries
// ---------------------------------------------------------------------------

const listEntriesSchema = z.object({
  status: z.enum(ENTRY_STATUSES).optional(),
  direction: z.enum(ENTRY_DIRECTIONS).optional(),
  /** Formato YYYY-MM; filtra por competência: settled_at, senão due_date, senão created_at. */
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Mês inválido: use o formato YYYY-MM.")
    .optional(),
  limit: z.number().int().positive().max(500).default(100),
});

export type ListEntriesInput = z.input<typeof listEntriesSchema>;

export async function listEntries(db: DbOrTx, input: ListEntriesInput = {}) {
  const parsed = listEntriesSchema.parse(input);

  const conditions = [];
  if (parsed.status) {
    conditions.push(eq(financialEntries.status, parsed.status));
  }
  if (parsed.direction) {
    conditions.push(eq(financialEntries.direction, parsed.direction));
  }
  if (parsed.month) {
    const [yearStr, monthStr] = parsed.month.split("-");
    const year = Number(yearStr);
    const month = Number(monthStr);
    const start = new Date(Date.UTC(year, month - 1, 1)).toISOString();
    const end = new Date(Date.UTC(year, month, 1)).toISOString();
    conditions.push(sql`
      coalesce(
        ${financialEntries.settledAt},
        ${financialEntries.dueDate}::timestamptz,
        ${financialEntries.createdAt}
      ) >= ${start}
      AND coalesce(
        ${financialEntries.settledAt},
        ${financialEntries.dueDate}::timestamptz,
        ${financialEntries.createdAt}
      ) < ${end}
    `);
  }

  return db
    .select({
      ...getTableColumns(financialEntries),
      // Nome do fornecedor vinculado (null quando não há vínculo).
      supplierName: suppliers.name,
    })
    .from(financialEntries)
    .leftJoin(suppliers, eq(suppliers.id, financialEntries.supplierId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(financialEntries.createdAt), desc(financialEntries.id))
    .limit(parsed.limit);
}
