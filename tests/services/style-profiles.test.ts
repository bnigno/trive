// Cartela de estilo: uma por telefone, merge do que já se sabia, vínculo ao
// cadastro, consentimento que nunca rebaixa, "esquecer" que zera e libera o
// telefone para uma cartela nova, e a edição curada sobre o catálogo real.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { listPublicVariantFacts } from "@/services/store-catalog";
import {
  curateEditionForProfile,
  forgetStyleProfile,
  getStyleProfileByCustomer,
  getStyleProfileByPhone,
  getStyleProfileByToken,
  linkStyleProfileToCustomer,
  saveStyleProfile,
} from "@/services/style-profiles";
import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;

const PHONE = "+5511999990000";

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
});

afterEach(async () => {
  await close();
});

async function product(
  name: string,
  slug: string,
  variants: { sku: string; attributes: Record<string, string>; onHand: number; priceCents?: number }[],
  opts: { category?: string; photo?: boolean } = {},
) {
  let categoryId: string | undefined;
  if (opts.category) {
    const [cat] = await db
      .insert(schema.categories)
      .values({ name: opts.category, slug: opts.category.toLowerCase() })
      .onConflictDoNothing()
      .returning({ id: schema.categories.id });
    categoryId = cat?.id;
    if (!categoryId) {
      const [existing] = await db.select({ id: schema.categories.id }).from(schema.categories).where(eq(schema.categories.slug, opts.category.toLowerCase()));
      categoryId = existing.id;
    }
  }
  const [p] = await db
    .insert(schema.products)
    .values({ name, slug, status: "active", attributesSchema: ["cor", "tamanho"], ...(categoryId ? { categoryId } : {}) })
    .returning({ id: schema.products.id });
  for (const v of variants) {
    const [variant] = await db
      .insert(schema.productVariants)
      .values({ productId: p.id, sku: v.sku, costCents: 1000, attributes: v.attributes })
      .returning({ id: schema.productVariants.id });
    await db.insert(schema.stockLevels).values({ productVariantId: variant.id, onHand: v.onHand, reserved: 0 });
    await db.insert(schema.priceVersions).values({
      productVariantId: variant.id,
      versionNumber: 1,
      status: "active",
      priceCents: v.priceCents ?? 20000,
      origin: "initial",
      breakdown: {},
      costSnapshotCents: 1000,
      computedMarginRate: "0.3000",
      activatedAt: new Date(),
    });
  }
  if (opts.photo !== false) {
    await db.insert(schema.productImages).values({ productId: p.id, storagePath: `${slug}/1-full.webp`, sortOrder: 0 });
  }
  return p.id;
}

describe("saveStyleProfile", () => {
  it("cria por telefone, mescla no segundo salvamento, nomeia a cartela e liga ao cadastro pelo telefone", async () => {
    const [customer] = await db
      .insert(schema.customers)
      .values({ fullName: "Ana Souza", phoneE164: PHONE, marketingOptIn: true })
      .returning({ id: schema.customers.id });

    const first = await saveStyleProfile(sdb, {
      phoneE164: PHONE,
      patch: { sizes: { vestido: "M" }, colorsLove: ["Terracota"], fit: "fluido" },
      source: "quiz",
      consent: true,
    });
    expect(first.paletteName).toBe("Terra fluida");
    expect(first.customerId).toBe(customer.id);
    expect(first.consentAt).not.toBeNull();
    expect(first.siteToken).toMatch(/^[0-9a-f-]{36}$/);

    const second = await saveStyleProfile(sdb, {
      phoneE164: PHONE,
      patch: { sizes: { calca: "40" }, colorsAvoid: ["Amarelo"], occasions: ["casamento"] },
      source: "lia",
    });
    expect(second.id).toBe(first.id);
    expect(second.profile).toEqual({
      sizes: { vestido: "M", calca: "40" },
      colorsLove: ["Terracota"],
      colorsAvoid: ["Amarelo"],
      fit: "fluido",
      occasions: ["casamento"],
      buysFor: null,
    });
    // Consentimento não rebaixa: a Lia salvou sem consent=true e ele continua.
    expect(second.consentAt?.getTime()).toBe(first.consentAt?.getTime());
    expect(second.source).toBe("lia");
    expect(await getStyleProfileByToken(sdb, first.siteToken)).toMatchObject({ id: first.id });
    expect(await getStyleProfileByCustomer(sdb, { customerId: customer.id })).toMatchObject({ id: first.id });

    const audits = await db.select({ action: schema.auditLog.action }).from(schema.auditLog);
    expect(audits.map((a) => a.action)).toEqual(["style.profile_create", "style.profile_update"]);
  });

  it("esquecer zera tudo, some das consultas e libera o telefone para uma cartela nova", async () => {
    const saved = await saveStyleProfile(sdb, { phoneE164: PHONE, patch: { colorsLove: ["Preto"] }, source: "quiz", consent: true });
    expect(await forgetStyleProfile(sdb, { siteToken: saved.siteToken })).toEqual({ forgotten: true });
    expect(await forgetStyleProfile(sdb, { siteToken: saved.siteToken })).toEqual({ forgotten: false });
    expect(await getStyleProfileByPhone(sdb, PHONE)).toBeNull();
    expect(await getStyleProfileByToken(sdb, saved.siteToken)).toBeNull();
    const [row] = await db.select().from(schema.customerProfiles).where(eq(schema.customerProfiles.id, saved.id));
    expect(row.profile).toEqual({});
    expect(row.forgottenAt).not.toBeNull();

    const fresh = await saveStyleProfile(sdb, { phoneE164: PHONE, patch: { colorsLove: ["Verde"] }, source: "quiz", consent: true });
    expect(fresh.id).not.toBe(saved.id);
    expect(fresh.paletteName).toBe("Bosque livre");
  });

  it("linkStyleProfileToCustomer vincula pelo token (checkout)", async () => {
    const saved = await saveStyleProfile(sdb, { phoneE164: "+5511999990001", patch: { fit: "justo" }, source: "quiz", consent: true });
    const [customer] = await db.insert(schema.customers).values({ fullName: "Bia", phoneE164: "+5511999990001" }).returning({ id: schema.customers.id });
    expect(await linkStyleProfileToCustomer(sdb, { siteToken: saved.siteToken, customerId: customer.id })).toBe(true);
    expect((await getStyleProfileByToken(sdb, saved.siteToken))?.customerId).toBe(customer.id);
    expect(await linkStyleProfileToCustomer(sdb, { siteToken: "nao-e-uuid", customerId: customer.id })).toBe(false);
  });
});

describe("listPublicVariantFacts / curateEditionForProfile", () => {
  it("lista tamanhos e cores COM estoque por produto e cura a edição pela cartela", async () => {
    await product("Vestido Dunas", "vestido-dunas", [
      { sku: "D-TER-M", attributes: { cor: "Terracota", tamanho: "M" }, onHand: 2 },
      { sku: "D-PRE-G", attributes: { cor: "Preto", tamanho: "G" }, onHand: 0 },
    ], { category: "Vestuário" });
    await product("Blusa de Linho", "blusa-linho", [
      { sku: "B-VER-P", attributes: { cor: "Verde", tamanho: "P" }, onHand: 1, priceCents: 15000 },
    ], { category: "Vestuário" });
    await product("Saia Sol", "saia-sol", [
      { sku: "S-AMA-40", attributes: { cor: "Amarelo", tamanho: "40" }, onHand: 3 },
    ], { category: "Vestuário" });
    await product("Vestido Sem Foto", "sem-foto", [
      { sku: "X-TER-M", attributes: { cor: "Terracota", tamanho: "M" }, onHand: 3 },
    ], { category: "Vestuário", photo: false });

    const facts = await listPublicVariantFacts(sdb);
    const dunas = facts.find((f) => f.product.slug === "vestido-dunas");
    expect(dunas?.sizesAvailable).toEqual(["M"]);
    expect(dunas?.colorsAvailable).toEqual(["Terracota"]);

    const items = await curateEditionForProfile(sdb, {
      sizes: { vestido: "M", blusa: "P", calca: "40" },
      colorsLove: ["Terracota", "Verde"],
      colorsAvoid: ["Amarelo"],
      fit: "fluido",
      occasions: [],
      buysFor: null,
    });
    // Empate na pontuação (tamanho + cor): a mais barata primeiro.
    expect(items.map((item) => item.product.slug)).toEqual(["blusa-linho", "vestido-dunas"]);
    expect(items[0].reasons).toEqual(["no seu P", "em Verde"]);
    expect(items[1].reasons).toEqual(["no seu M", "em Terracota"]);

    expect(await curateEditionForProfile(sdb, { sizes: {}, colorsLove: [], colorsAvoid: [], fit: null, occasions: [], buysFor: null })).toEqual([]);
  });
});
