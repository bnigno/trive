import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, createTestVariant, createTestFeeRuleAndPolicy, FIXED_USER_ID } from "./db";

describe("infra de testes (PGlite + migrações)", () => {
  it("aplica migrações, fixtures e respeita triggers de imutabilidade", async () => {
    const { db, close } = await createTestDb();
    try {
      const { variantId } = await createTestVariant(db, { sku: "TESTE-1", onHand: 5 });
      await createTestFeeRuleAndPolicy(db);

      const [level] = await db
        .select()
        .from(schema.stockLevels)
        .where(eq(schema.stockLevels.productVariantId, variantId));
      expect(level.onHand).toBe(5);

      await db.insert(schema.stockMovements).values({
        productVariantId: variantId,
        type: "purchase_in",
        quantityDelta: 5,
        createdBy: FIXED_USER_ID,
      });
      // trigger de imutabilidade: UPDATE em stock_movements deve falhar
      await expect(
        db.execute(sql`update stock_movements set quantity_delta = 10`),
      ).rejects.toThrow();

      // CHECK de estoque: reserved > on_hand deve falhar
      await expect(
        db
          .update(schema.stockLevels)
          .set({ reserved: 99 })
          .where(eq(schema.stockLevels.productVariantId, variantId)),
      ).rejects.toThrow();
    } finally {
      await close();
    }
  });
});
