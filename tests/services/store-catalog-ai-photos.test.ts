// Foto no corpo na vitrine e na Lia (PGlite): por padrão a loja só mostra
// fotos reais; com ai_photos_in_store a foto no corpo vira capa (a real fica
// no hover); a Lia, o post e a cortina pedem "prefer" e ganham a foto no
// corpo mesmo com o interruptor desligado; "hide" é sempre só as reais.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/db/schema";
import { getPublicProductBySlug, listPublicProducts, resolveAiPhotoPolicy, type ServiceDb } from "@/services/store-catalog";
import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;
let sdb: ServiceDb;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as ServiceDb;
  vi.stubEnv("ADAPTER_MODE", "fake");
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
});

/** Peça vendável com três fotos: real da cor (0), foto no corpo da cor (1), real do produto inteiro (2). */
async function seed(): Promise<string> {
  const [product] = await db
    .insert(schema.products)
    .values({ name: "Vestido Áurea", slug: "vestido-aurea", status: "active", attributesSchema: ["cor"] })
    .returning({ id: schema.products.id });
  const [variant] = await db.insert(schema.productVariants).values({ productId: product!.id, sku: "AUR-AREIA", attributes: { cor: "Areia" } }).returning({ id: schema.productVariants.id });
  await db.insert(schema.stockLevels).values({ productVariantId: variant!.id, onHand: 2, reserved: 0 });
  await db.insert(schema.priceVersions).values({
    productVariantId: variant!.id,
    versionNumber: 1,
    status: "active",
    priceCents: 28900,
    origin: "initial",
    breakdown: {},
    costSnapshotCents: 0,
    computedMarginRate: "0.3000",
    activatedAt: new Date(),
  });
  await db.insert(schema.productImages).values([
    { productId: product!.id, storagePath: "p/real-areia-full.webp", color: "Areia", sortOrder: 0, origin: "upload" },
    { productId: product!.id, storagePath: "p/ai-areia-full.webp", color: "Areia", sortOrder: 1, origin: "ai" },
    { productId: product!.id, storagePath: "p/real-geral-full.webp", color: null, sortOrder: 2, origin: "upload" },
  ]);
  return product!.id;
}

describe("foto no corpo: política na vitrine e na Lia", () => {
  it("por padrão a vitrine esconde a foto no corpo; com o interruptor ela vira a capa e a real vai para o hover", async () => {
    await seed();
    expect(await resolveAiPhotoPolicy(sdb, "store")).toBe("hide");
    let [item] = await listPublicProducts(sdb, { limit: 10 });
    expect(item).toMatchObject({ imagePath: "p/real-areia-full.webp", hoverImagePath: "p/real-geral-full.webp" });
    let detail = await getPublicProductBySlug(sdb, "vestido-aurea");
    expect(detail?.images.map((image) => image.path)).toEqual(["p/real-areia-full.webp", "p/real-geral-full.webp"]);
    expect(detail?.images.every((image) => image.origin === "upload")).toBe(true);

    await db.insert(schema.settings).values({ key: "ai_photos_in_store", value: true });
    expect(await resolveAiPhotoPolicy(sdb, "store")).toBe("prefer");
    [item] = await listPublicProducts(sdb, { limit: 10 });
    expect(item).toMatchObject({ imagePath: "p/ai-areia-full.webp", hoverImagePath: "p/real-areia-full.webp" });
    detail = await getPublicProductBySlug(sdb, "vestido-aurea");
    expect(detail?.images.map((image) => image.path)).toEqual(["p/ai-areia-full.webp", "p/real-areia-full.webp", "p/real-geral-full.webp"]);
  });

  it("'prefer' (Lia, post, story, cortina) ganha a foto no corpo mesmo com o interruptor desligado; 'hide' nunca a mostra", async () => {
    await seed();
    const [preferred] = await listPublicProducts(sdb, { limit: 10, aiPhotos: "prefer" });
    expect(preferred).toMatchObject({ imagePath: "p/ai-areia-full.webp", hoverImagePath: "p/real-areia-full.webp" });
    const detail = await getPublicProductBySlug(sdb, "vestido-aurea", undefined, { aiPhotos: "prefer" });
    expect(detail?.images[0]).toMatchObject({ path: "p/ai-areia-full.webp", origin: "ai" });

    await db.insert(schema.settings).values({ key: "ai_photos_in_store", value: true });
    const [hidden] = await listPublicProducts(sdb, { limit: 10, aiPhotos: "hide" });
    expect(hidden).toMatchObject({ imagePath: "p/real-areia-full.webp", hoverImagePath: "p/real-geral-full.webp" });
    const hiddenDetail = await getPublicProductBySlug(sdb, "vestido-aurea", undefined, { aiPhotos: "hide" });
    expect(hiddenDetail?.images.some((image) => image.origin === "ai")).toBe(false);
  });

  it("sem foto no corpo, 'prefer' é a ordem de sempre (real e hover distintos)", async () => {
    const productId = await seed();
    await db.delete(schema.productImages).where((await import("drizzle-orm")).eq(schema.productImages.origin, "ai"));
    const [item] = await listPublicProducts(sdb, { limit: 10, aiPhotos: "prefer" });
    expect(item?.id).toBe(productId);
    expect(item).toMatchObject({ imagePath: "p/real-areia-full.webp", hoverImagePath: "p/real-geral-full.webp" });
  });
});
