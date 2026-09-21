// Migração 0056 (foto no corpo) no PGlite: origin em product_images com
// default 'upload' e CHECK; uma foto-base escolhida por modela × cena ×
// corpo (índice parcial); candidata única por pedido × opção × tentativa;
// settings do ensaio semeados desligados e dentro das chaves permitidas.
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { initialSettings } from "@/db/seed-data";
import { ALLOWED_SETTING_KEYS } from "@/services/settings";
import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;

/** O drizzle embrulha o erro do Postgres: o nome da constraint fica na causa. */
async function violates(promise: Promise<unknown>, constraint: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e as Error & { cause?: { message?: string; constraint?: string } },
  );
  expect(error).not.toBeNull();
  const text = `${error?.message ?? ""} ${error?.cause?.message ?? ""} ${error?.cause?.constraint ?? ""}`;
  expect(text).toContain(constraint);
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  await close();
});

describe("schema do ensaio", () => {
  it("product_images.origin nasce 'upload' e só aceita 'upload' ou 'ai'", async () => {
    const [product] = await db.insert(schema.products).values({ name: "P", slug: "p", status: "active" }).returning({ id: schema.products.id });
    const [image] = await db.insert(schema.productImages).values({ productId: product!.id, storagePath: "products/p/a-full.webp" }).returning();
    expect(image?.origin).toBe("upload");
    await violates(db.execute(sql`update product_images set origin = 'x' where id = ${image!.id}`), "product_images_origin_check");
    await db.execute(sql`update product_images set origin = 'ai' where id = ${image!.id}`);
  });

  it("uma escolhida por modela × cena × corpo; candidata única por pedido × opção × tentativa", async () => {
    const base = { modelKey: "modelo_a", sceneKey: "sala_clara", sizeKey: "M", vendor: "fake", vendorModel: "fake" };
    await db.insert(schema.studioBasePhotos).values({ ...base, storagePath: "a.jpg", status: "chosen" });
    await db.insert(schema.studioBasePhotos).values({ ...base, storagePath: "b.jpg", status: "candidate" });
    await violates(db.insert(schema.studioBasePhotos).values({ ...base, storagePath: "c.jpg", status: "chosen" }), "studio_base_photos_chosen_unique_idx");
    await db.insert(schema.studioBasePhotos).values({ ...base, sizeKey: "G", storagePath: "d.jpg", status: "chosen" });

    const [product] = await db.insert(schema.products).values({ name: "P", slug: "p", status: "active" }).returning({ id: schema.products.id });
    const [request] = await db
      .insert(schema.studioRequests)
      .values({ productId: product!.id, sceneKey: "sala_clara", modelKey: "modelo_a", sizeKey: "M", quality: "economica", optionsWanted: 3 })
      .returning({ id: schema.studioRequests.id });
    await db.insert(schema.studioCandidates).values({ requestId: request!.id, optionNo: 1, attempt: 0 });
    await violates(db.insert(schema.studioCandidates).values({ requestId: request!.id, optionNo: 1, attempt: 0 }), "studio_candidates_request_option_attempt_unique_idx");
    await db.insert(schema.studioCandidates).values({ requestId: request!.id, optionNo: 1, attempt: 1 });
    await violates(db.insert(schema.studioRequests).values({ productId: product!.id, sceneKey: "x", modelKey: "y", sizeKey: "M", quality: "media", optionsWanted: 3 }), "studio_requests_quality_check");
    await violates(db.insert(schema.studioRequests).values({ productId: product!.id, sceneKey: "x", modelKey: "y", sizeKey: "M", quality: "alta", optionsWanted: 5 }), "studio_requests_options_check");
    // Apagar o pedido leva as candidatas junto; apagar a peça leva o pedido.
    await db.execute(sql`delete from products where id = ${product!.id}`);
    expect(await db.select().from(schema.studioCandidates)).toHaveLength(0);
  });

  it("settings do ensaio: semeados desligados, com padrões, dentro das chaves permitidas", () => {
    const seeded = Object.fromEntries(initialSettings.map((setting) => [setting.key, setting.value]));
    expect(seeded["ai_photos_enabled"]).toBe(false);
    expect(seeded["ai_photos_in_store"]).toBe(false);
    expect(seeded["ai_photos_daily_quota"]).toBe(30);
    expect(seeded["ai_photos_quality"]).toBe("economica");
    expect(seeded["ai_photos_default_scene"]).toBe("sala_clara");
    expect(seeded["ai_photos_default_model"]).toBe("modelo_a");
    for (const key of ["ai_photos_enabled", "ai_photos_in_store", "ai_photos_daily_quota", "ai_photos_quality", "ai_photos_default_scene", "ai_photos_default_model"]) {
      expect(ALLOWED_SETTING_KEYS).toContain(key);
    }
  });
});
