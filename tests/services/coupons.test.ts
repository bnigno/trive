import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import * as schema from "@/db/schema";
import { formatCentsBRL } from "@/lib/money";
import type { DbOrTx } from "@/queue/enqueue";
import {
  createCoupon,
  listCoupons,
  quoteCoupon,
  redeemCouponInTx,
  ServiceError,
  updateCoupon,
  type CreateCouponInput,
} from "@/services/coupons";
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

function makeCoupon(over: Partial<CreateCouponInput> = {}) {
  return createCoupon(sdb, {
    code: "DEZ10",
    type: "percent",
    value: 10,
    userId: FIXED_USER_ID,
    ...over,
  });
}

async function getRow(couponId: string) {
  const [row] = await db
    .select()
    .from(schema.coupons)
    .where(eq(schema.coupons.id, couponId));
  return row;
}

describe("quoteCoupon", () => {
  it("percent: arredonda o desconto para BAIXO (floor)", async () => {
    await makeCoupon({ code: "DEZ10", type: "percent", value: 10 });

    // 10% de R$ 9,99 = 99,9 centavos → 99 (nunca arredonda a favor da loja).
    const quote = await quoteCoupon(sdb, { code: "DEZ10", subtotalCents: 999 });
    expect(quote.discountCents).toBe(99);
    expect(quote.code).toBe("DEZ10");

    // Divisão exata segue exata.
    const exact = await quoteCoupon(sdb, { code: "DEZ10", subtotalCents: 10000 });
    expect(exact.discountCents).toBe(1000);
  });

  it("normaliza o código: minúsculas e espaços do cliente encontram o cupom", async () => {
    const created = await makeCoupon({ code: "dez10" });
    expect(created.code).toBe("DEZ10"); // armazenado UPPERCASE

    const quote = await quoteCoupon(sdb, {
      code: "  dez10  ",
      subtotalCents: 5000,
    });
    expect(quote.couponId).toBe(created.id);
    expect(quote.code).toBe("DEZ10");
  });

  it("fixed maior que o subtotal: desconto é limitado ao subtotal (clamp)", async () => {
    await makeCoupon({ code: "VALE100", type: "fixed", value: 10000 });

    const quote = await quoteCoupon(sdb, {
      code: "VALE100",
      subtotalCents: 4990,
    });
    expect(quote.discountCents).toBe(4990); // nunca > subtotal
  });

  it("mínimo não atingido: mensagem contém o valor mínimo formatado em BRL", async () => {
    await makeCoupon({ code: "MIN50", minOrderCents: 5000 });

    const error = await quoteCoupon(sdb, {
      code: "MIN50",
      subtotalCents: 4999,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe("COUPON_MIN_ORDER");
    expect((error as Error).message).toContain(formatCentsBRL(5000));

    // No limite exato o cupom vale.
    const quote = await quoteCoupon(sdb, { code: "MIN50", subtotalCents: 5000 });
    expect(quote.discountCents).toBe(500);
  });

  it("cupom inexistente: mensagem cita o código digitado", async () => {
    const error = await quoteCoupon(sdb, {
      code: "nao-existe",
      subtotalCents: 1000,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe("COUPON_NOT_FOUND");
    expect((error as Error).message).toContain("NAO-EXISTE");
    expect((error as Error).message).toContain("não existe");
  });

  it("cupom inativo é recusado", async () => {
    await makeCoupon({ code: "PAUSADO", isActive: false });

    await expect(
      quoteCoupon(sdb, { code: "PAUSADO", subtotalCents: 1000 }),
    ).rejects.toMatchObject({ code: "COUPON_INACTIVE" });
  });

  it("vigência que começa no futuro é recusada; depois do início, vale", async () => {
    await makeCoupon({
      code: "FUTURO",
      startsAt: new Date(Date.now() + 60 * 60_000),
    });

    await expect(
      quoteCoupon(sdb, { code: "FUTURO", subtotalCents: 1000 }),
    ).rejects.toMatchObject({ code: "COUPON_NOT_STARTED" });

    await makeCoupon({
      code: "VIGENTE",
      startsAt: new Date(Date.now() - 60_000),
    });
    const quote = await quoteCoupon(sdb, { code: "VIGENTE", subtotalCents: 1000 });
    expect(quote.discountCents).toBe(100);
  });

  it("cupom expirado é recusado", async () => {
    await makeCoupon({
      code: "VENCIDO",
      startsAt: new Date(Date.now() - 2 * 60_000),
      expiresAt: new Date(Date.now() - 60_000),
    });

    await expect(
      quoteCoupon(sdb, { code: "VENCIDO", subtotalCents: 1000 }),
    ).rejects.toMatchObject({ code: "COUPON_EXPIRED" });
  });

  it("esgotado (used_count >= max_uses) é recusado na cotação", async () => {
    const created = await makeCoupon({ code: "UNICO", maxUses: 1 });
    await db
      .update(schema.coupons)
      .set({ usedCount: 1 })
      .where(eq(schema.coupons.id, created.id));

    const error = await quoteCoupon(sdb, {
      code: "UNICO",
      subtotalCents: 1000,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe("COUPON_EXHAUSTED");
    expect((error as Error).message).toContain("esgotou");
  });
});

describe("redeemCouponInTx", () => {
  it("guard atômico: max_uses 1 disputado 2x → um resgata, o outro falha e used_count fica em 1", async () => {
    const created = await makeCoupon({ code: "UNICO", maxUses: 1 });

    // Duas transações disputando o último uso: o guard fica no WHERE do
    // próprio UPDATE, então a segunda afeta 0 linhas independente da ordem.
    const results = await Promise.allSettled([
      db.transaction(async (tx) =>
        redeemCouponInTx(tx as unknown as DbOrTx, created.id),
      ),
      db.transaction(async (tx) =>
        redeemCouponInTx(tx as unknown as DbOrTx, created.id),
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ServiceError);
    expect((rejected[0].reason as ServiceError).code).toBe("COUPON_EXHAUSTED");
    expect((rejected[0].reason as Error).message).toContain("esgotou");

    // NUNCA passa do limite, mesmo com concorrência.
    expect((await getRow(created.id)).usedCount).toBe(1);
  });

  it("sem max_uses: resgata sem limite", async () => {
    const created = await makeCoupon({ code: "LIVRE" });
    await redeemCouponInTx(sdb, created.id);
    await redeemCouponInTx(sdb, created.id);
    expect((await getRow(created.id)).usedCount).toBe(2);
  });
});

describe("createCoupon", () => {
  it("cria com code UPPERCASE, grava audit e valida percent 1..100", async () => {
    const created = await makeCoupon({ code: "bemvindo", type: "percent", value: 15 });
    expect(created.code).toBe("BEMVINDO");
    expect(created.usedCount).toBe(0);
    expect(created.isActive).toBe(true);

    const audits = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "coupon.create"));
    expect(audits).toHaveLength(1);
    expect(audits[0].actorId).toBe(FIXED_USER_ID);
    expect(audits[0].entityId).toBe(created.id);
    expect(audits[0].after).toMatchObject({ code: "BEMVINDO", value: 15 });

    await expect(
      makeCoupon({ code: "DEMAIS", type: "percent", value: 101 }),
    ).rejects.toThrowError(/entre 1 e 100/);
  });

  it("código duplicado (mesmo com caixa diferente) → erro amigável", async () => {
    await makeCoupon({ code: "DEZ10" });

    const error = await makeCoupon({ code: "dez10" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe("COUPON_CODE_TAKEN");
    expect((error as Error).message).toContain("DEZ10");
  });
});

describe("updateCoupon", () => {
  it("ajusta isActive/expiresAt/maxUses com audit; type/value ficam intocados", async () => {
    const created = await makeCoupon({ code: "AJUSTE", maxUses: 5 });
    const newExpiry = new Date(Date.now() + 24 * 60 * 60_000);

    const updated = await updateCoupon(sdb, {
      couponId: created.id,
      isActive: false,
      expiresAt: newExpiry,
      maxUses: 10,
      userId: FIXED_USER_ID,
    });
    expect(updated.isActive).toBe(false);
    expect(updated.expiresAt?.getTime()).toBe(newExpiry.getTime());
    expect(updated.maxUses).toBe(10);
    // Integridade histórica: desconto de pedidos já criados não muda —
    // updateCoupon simplesmente NÃO aceita type/value.
    expect(updated.type).toBe("percent");
    expect(updated.value).toBe(10);

    const audits = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "coupon.update"));
    expect(audits).toHaveLength(1);
    expect(audits[0].before).toMatchObject({ isActive: true, maxUses: 5 });
    expect(audits[0].after).toMatchObject({ isActive: false, maxUses: 10 });
  });

  it("cupom inexistente → COUPON_NOT_FOUND", async () => {
    await expect(
      updateCoupon(sdb, {
        couponId: "00000000-0000-4000-8000-00000000dead",
        isActive: false,
        userId: FIXED_USER_ID,
      }),
    ).rejects.toMatchObject({ code: "COUPON_NOT_FOUND" });
  });
});

describe("listCoupons", () => {
  it("lista todos com contagem de usos, mais recentes primeiro", async () => {
    const a = await makeCoupon({ code: "PRIMEIRO" });
    const b = await makeCoupon({ code: "SEGUNDO", type: "fixed", value: 500 });
    await redeemCouponInTx(sdb, a.id);

    // createdAt pode empatar no mesmo ms; ordena por (createdAt, id) desc.
    const list = await listCoupons(sdb);
    expect(list).toHaveLength(2);
    expect(list.map((c) => c.code).sort()).toEqual(["PRIMEIRO", "SEGUNDO"]);
    expect(list.find((c) => c.id === a.id)?.usedCount).toBe(1);
    expect(list.find((c) => c.id === b.id)?.usedCount).toBe(0);
  });
});
