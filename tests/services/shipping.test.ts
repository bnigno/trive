// Integração do serviço de frete (admin) com banco real (PGlite + migrações).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import * as schema from "@/db/schema";
import {
  createShippingRate,
  listShippingRates,
  ServiceError,
  updateShippingRate,
} from "@/services/shipping";
import { quoteShipping } from "@/services/store-catalog";
import { createTestDb, FIXED_USER_ID, type TestDb } from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});

afterAll(async () => {
  await close();
});

describe("createShippingRate / listShippingRates", () => {
  it("cria a faixa (CEP com máscara é normalizado) e lista com audit", async () => {
    const created = await createShippingRate(db, {
      name: "Brasil inteiro",
      cepStart: "00000-000",
      cepEnd: "99999-999",
      weightMinGrams: 0,
      weightMaxGrams: 30000,
      priceCents: 2490,
      deliveryDaysMin: 3,
      deliveryDaysMax: 10,
      userId: FIXED_USER_ID,
    });

    expect(created.cepStart).toBe("00000000");
    expect(created.cepEnd).toBe("99999999");
    expect(created.priceCents).toBe(2490);
    expect(created.isActive).toBe(true);

    const rates = await listShippingRates(db);
    expect(rates.map((r) => r.id)).toContain(created.id);

    const audits = await db
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.entityId, created.id));
    expect(audits.map((a) => a.action)).toContain("shipping.create");
  });

  it("rejeita faixa de CEP invertida com mensagem pt-BR", async () => {
    await expect(
      createShippingRate(db, {
        name: "Invertida",
        cepStart: "90000000",
        cepEnd: "01000000",
        weightMinGrams: 0,
        weightMaxGrams: 1000,
        priceCents: 1000,
        deliveryDaysMin: 1,
        deliveryDaysMax: 5,
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow(
      "A faixa de CEP está invertida: o CEP inicial deve ser menor ou igual ao CEP final.",
    );
  });

  it("rejeita faixa de peso invertida e prazo invertido", async () => {
    const base = {
      name: "Faixa",
      cepStart: "00000000",
      cepEnd: "99999999",
      priceCents: 1000,
      userId: FIXED_USER_ID,
    };
    await expect(
      createShippingRate(db, {
        ...base,
        weightMinGrams: 5000,
        weightMaxGrams: 1000,
        deliveryDaysMin: 1,
        deliveryDaysMax: 5,
      }),
    ).rejects.toThrow(ServiceError);
    await expect(
      createShippingRate(db, {
        ...base,
        weightMinGrams: 0,
        weightMaxGrams: 1000,
        deliveryDaysMin: 9,
        deliveryDaysMax: 2,
      }),
    ).rejects.toThrow(/prazo de entrega está invertido/i);
  });

  it("rejeita CEP que não tem 8 dígitos", async () => {
    await expect(
      createShippingRate(db, {
        name: "CEP curto",
        cepStart: "0100",
        cepEnd: "99999999",
        weightMinGrams: 0,
        weightMaxGrams: 1000,
        priceCents: 500,
        deliveryDaysMin: 1,
        deliveryDaysMax: 3,
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow(/CEP inicial inválido/i);
  });
});

describe("updateShippingRate", () => {
  it("edita os campos e desativa; a faixa some da cotação da vitrine", async () => {
    const created = await createShippingRate(db, {
      name: "Capital SP",
      cepStart: "01000000",
      cepEnd: "05999999",
      weightMinGrams: 0,
      weightMaxGrams: 30000,
      priceCents: 990,
      deliveryDaysMin: 1,
      deliveryDaysMax: 3,
      userId: FIXED_USER_ID,
    });

    const quotedBefore = await quoteShipping(db, {
      cep: "01310-100",
      totalWeightGrams: 600,
    });
    expect(quotedBefore.map((q) => q.rateId)).toContain(created.id);

    const updated = await updateShippingRate(db, {
      id: created.id,
      name: "Capital SP (pausada)",
      cepStart: "01000000",
      cepEnd: "05999999",
      weightMinGrams: 0,
      weightMaxGrams: 30000,
      priceCents: 1290,
      deliveryDaysMin: 2,
      deliveryDaysMax: 4,
      isActive: false,
      userId: FIXED_USER_ID,
    });

    expect(updated.id).toBe(created.id);
    expect(updated.isActive).toBe(false);
    expect(updated.priceCents).toBe(1290);
    expect(updated.name).toBe("Capital SP (pausada)");

    // Desativada continua na listagem do admin…
    const rates = await listShippingRates(db);
    const listed = rates.find((r) => r.id === created.id);
    expect(listed?.isActive).toBe(false);

    // …mas some da cotação pública.
    const quotedAfter = await quoteShipping(db, {
      cep: "01310-100",
      totalWeightGrams: 600,
    });
    expect(quotedAfter.map((q) => q.rateId)).not.toContain(created.id);

    const audits = await db
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.entityId, created.id));
    expect(audits.map((a) => a.action)).toContain("shipping.update");
  });

  it("rejeita id inexistente com ServiceError", async () => {
    await expect(
      updateShippingRate(db, {
        id: "00000000-0000-4000-8000-0000000000aa",
        name: "Fantasma",
        cepStart: "00000000",
        cepEnd: "99999999",
        weightMinGrams: 0,
        weightMaxGrams: 1000,
        priceCents: 100,
        deliveryDaysMin: 1,
        deliveryDaysMax: 2,
        isActive: true,
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow(/não encontrada/i);
  });
});
