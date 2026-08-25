import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import {
  cancelEntry,
  createManualEntry,
  FinancialServiceError,
  listEntries,
  monthOverview,
  settleEntry,
} from "@/services/financial";
import { createTestDb, FIXED_USER_ID, type TestDb } from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;
// PGlite (testes) e postgres-js (produção) divergem apenas no tipo de
// retorno de execute(); a API drizzle usada pelos serviços é idêntica.
let sdb: DbOrTx;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
});

afterEach(async () => {
  await close();
});

async function getEntry(entryId: string) {
  const [entry] = await db
    .select()
    .from(schema.financialEntries)
    .where(eq(schema.financialEntries.id, entryId));
  return entry;
}

describe("createManualEntry", () => {
  it("cria lançamento pendente com audit", async () => {
    const { entryId } = await createManualEntry(sdb, {
      direction: "payable",
      category: "supplier",
      description: "Tecido fornecedor X",
      amountCents: 35000,
      dueDate: "2026-09-10",
      userId: FIXED_USER_ID,
    });

    const entry = await getEntry(entryId);
    expect(entry.direction).toBe("payable");
    expect(entry.category).toBe("supplier");
    expect(entry.status).toBe("pending");
    expect(entry.amountCents).toBe(35000);
    expect(entry.dueDate).toBe("2026-09-10");
    expect(entry.settledAt).toBeNull();
    expect(entry.createdBy).toBe(FIXED_USER_ID);

    const audits = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "financial_entry.create"));
    expect(audits).toHaveLength(1);
    expect(audits[0].entityId).toBe(entryId);
  });

  it("rejeita valor não positivo", async () => {
    await expect(
      createManualEntry(sdb, {
        direction: "receivable",
        category: "other",
        description: "Inválido",
        amountCents: 0,
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow();
  });
});

describe("settleEntry", () => {
  it("liquida pendente e não liquida duas vezes", async () => {
    const { entryId } = await createManualEntry(sdb, {
      direction: "receivable",
      category: "other",
      description: "Venda balcão",
      amountCents: 5000,
      userId: FIXED_USER_ID,
    });

    const result = await settleEntry(sdb, { entryId, userId: FIXED_USER_ID });
    expect(result.settledAt).toBeInstanceOf(Date);

    const entry = await getEntry(entryId);
    expect(entry.status).toBe("settled");
    expect(entry.settledAt).not.toBeNull();

    await expect(
      settleEntry(sdb, { entryId, userId: FIXED_USER_ID }),
    ).rejects.toThrow(FinancialServiceError);
    await expect(
      settleEntry(sdb, { entryId, userId: FIXED_USER_ID }),
    ).rejects.toThrow(/pendentes/);
  });
});

describe("cancelEntry", () => {
  it("exige motivo, cancela pendente e audita; não cancela liquidado", async () => {
    const { entryId } = await createManualEntry(sdb, {
      direction: "payable",
      category: "other",
      description: "Lançamento errado",
      amountCents: 1234,
      userId: FIXED_USER_ID,
    });

    await expect(
      // @ts-expect-error reason é obrigatório
      cancelEntry(sdb, { entryId, userId: FIXED_USER_ID }),
    ).rejects.toThrow();

    await cancelEntry(sdb, {
      entryId,
      userId: FIXED_USER_ID,
      reason: "Digitado em duplicidade",
    });
    expect((await getEntry(entryId)).status).toBe("canceled");

    const audits = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "financial_entry.cancel"));
    expect(audits).toHaveLength(1);
    expect(audits[0].reason).toBe("Digitado em duplicidade");

    const settled = await createManualEntry(sdb, {
      direction: "payable",
      category: "other",
      description: "Já pago",
      amountCents: 900,
      userId: FIXED_USER_ID,
    });
    await settleEntry(sdb, { entryId: settled.entryId, userId: FIXED_USER_ID });
    await expect(
      cancelEntry(sdb, {
        entryId: settled.entryId,
        userId: FIXED_USER_ID,
        reason: "Tentativa inválida",
      }),
    ).rejects.toThrow(/pendentes/);
  });
});

describe("monthOverview", () => {
  it("totaliza recebido/pago do mês (settled_at) e pendências abertas", async () => {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;

    // Liquidados no mês corrente (settled_at = agora).
    const received = await createManualEntry(sdb, {
      direction: "receivable",
      category: "sale",
      description: "Recebido no mês",
      amountCents: 10000,
      userId: FIXED_USER_ID,
    });
    await settleEntry(sdb, { entryId: received.entryId, userId: FIXED_USER_ID });

    const paid = await createManualEntry(sdb, {
      direction: "payable",
      category: "supplier",
      description: "Pago no mês",
      amountCents: 4000,
      userId: FIXED_USER_ID,
    });
    await settleEntry(sdb, { entryId: paid.entryId, userId: FIXED_USER_ID });

    // Pendências abertas.
    await createManualEntry(sdb, {
      direction: "receivable",
      category: "sale",
      description: "A receber",
      amountCents: 5000,
      userId: FIXED_USER_ID,
    });
    await createManualEntry(sdb, {
      direction: "payable",
      category: "supplier",
      description: "A pagar",
      amountCents: 2000,
      userId: FIXED_USER_ID,
    });

    // Liquidado em mês anterior: fora do recorte de recebido/pago.
    await db.insert(schema.financialEntries).values({
      direction: "receivable",
      category: "other",
      description: "Recebido mês passado",
      amountCents: 7777,
      status: "settled",
      settledAt: new Date(Date.UTC(year, month - 2, 10)),
    });

    // Cancelado: ignorado em todos os totais.
    const canceled = await createManualEntry(sdb, {
      direction: "payable",
      category: "other",
      description: "Cancelado",
      amountCents: 999,
      userId: FIXED_USER_ID,
    });
    await cancelEntry(sdb, {
      entryId: canceled.entryId,
      userId: FIXED_USER_ID,
      reason: "Erro de digitação",
    });

    const overview = await monthOverview(sdb, { year, month });
    expect(overview).toEqual({
      receivedCents: 10000,
      receivableCents: 5000,
      paidCents: 4000,
      payableCents: 2000,
      balanceCents: 6000,
    });

    const previous = await monthOverview(sdb, {
      year: month === 1 ? year - 1 : year,
      month: month === 1 ? 12 : month - 1,
    });
    expect(previous.receivedCents).toBe(7777);
    expect(previous.paidCents).toBe(0);
  });
});

describe("listEntries", () => {
  it("filtra por status, direção e mês (competência)", async () => {
    const a = await createManualEntry(sdb, {
      direction: "receivable",
      category: "sale",
      description: "Receber sem vencimento",
      amountCents: 100,
      userId: FIXED_USER_ID,
    });
    const b = await createManualEntry(sdb, {
      direction: "payable",
      category: "supplier",
      description: "Pagar em 2030",
      amountCents: 200,
      dueDate: "2030-01-15",
      userId: FIXED_USER_ID,
    });
    const c = await createManualEntry(sdb, {
      direction: "payable",
      category: "other",
      description: "Pago hoje",
      amountCents: 300,
      userId: FIXED_USER_ID,
    });
    await settleEntry(sdb, { entryId: c.entryId, userId: FIXED_USER_ID });

    const pendings = await listEntries(sdb, { status: "pending" });
    expect(pendings.map((e) => e.id).sort()).toEqual(
      [a.entryId, b.entryId].sort(),
    );

    const payables = await listEntries(sdb, { direction: "payable" });
    expect(payables.map((e) => e.id).sort()).toEqual(
      [b.entryId, c.entryId].sort(),
    );

    const now = new Date();
    const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const thisMonth = await listEntries(sdb, { month: currentMonth });
    expect(thisMonth.map((e) => e.id).sort()).toEqual(
      [a.entryId, c.entryId].sort(),
    );

    const jan2030 = await listEntries(sdb, { month: "2030-01" });
    expect(jan2030.map((e) => e.id)).toEqual([b.entryId]);

    await expect(listEntries(sdb, { month: "2030-13" })).rejects.toThrow(
      /YYYY-MM/,
    );
  });
});
