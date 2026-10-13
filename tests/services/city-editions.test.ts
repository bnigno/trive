// Edições de Belém com banco real (PGlite): criar com slug único, editar,
// vigência, peças (substituição em ordem), capa no Storage fake, leitura
// pública (vigente primeiro, encerradas de fora) e o filtro da vitrine.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { FakeFileStorage } from "@/adapters/storage/fake";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import {
  createCityEdition,
  getCityEdition,
  getCurrentCityEdition,
  getPublicCityEditionBySlug,
  listCityEditions,
  listPublicCityEditions,
  listStoreMapEditions,
  resolveCityEditionSlug,
  summarizeCityEditionsForDigest,
  setCityEditionCover,
  setCityEditionProducts,
  updateCityEdition,
} from "@/services/city-editions";
import { createDrop, getDrop, getUpcomingDropTeaser, setDropProducts } from "@/services/drops";
import { listPublicProducts } from "@/services/store-catalog";
import { createTestDb, createTestVariant, FIXED_USER_ID, type TestDb } from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;
let sdb: DbOrTx;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
});

afterEach(async () => {
  await close();
});

const IN_CIRIO = new Date("2026-10-05T12:00:00Z"); // 9h SP, 5/10
const BEFORE = new Date("2026-09-20T12:00:00Z");

async function sellable(name: string, sku: string): Promise<string> {
  const { productId, variantId } = await createTestVariant(db, { sku, costCents: 1000, onHand: 3, name });
  await db.insert(schema.priceVersions).values({
    productVariantId: variantId,
    versionNumber: 1,
    status: "active",
    priceCents: 19900,
    origin: "initial",
    breakdown: {},
    costSnapshotCents: 1000,
    computedMarginRate: "0.3000",
    activatedAt: new Date(),
  });
  return productId;
}

async function cirio() {
  return createCityEdition(sdb, {
    isActive: true,
    fields: {
      name: "Edição Círio",
      openingLine: "Vestida para o Círio",
      body: "Um parágrafo.\n\nOutro parágrafo.",
      districts: "Nazaré, Batista Campos\nUmarizal",
      startsOn: "2026-10-01",
      endsOn: "2026-10-12",
    },
    userId: FIXED_USER_ID,
  });
}

describe("createCityEdition / updateCityEdition", () => {
  it("cria com slug a partir do nome (único: o segundo ganha -2), valida vigência e edita", async () => {
    const a = await cirio();
    expect(a.slug).toBe("edicao-cirio");
    const b = await createCityEdition(sdb, { fields: { name: "Edição Círio" }, userId: FIXED_USER_ID });
    expect(b.slug).toBe("edicao-cirio-2");
    // Nasce desligada por padrão: a dona coloca capa e peças antes de aparecer.
    expect((await getCityEdition(sdb, b.editionId))?.isActive).toBe(false);

    await expect(
      createCityEdition(sdb, { fields: { name: "Errada", startsOn: "2026-10-12", endsOn: "2026-10-01" }, userId: FIXED_USER_ID }),
    ).rejects.toThrow(/depois do começo/);
    await expect(createCityEdition(sdb, { fields: { name: "Errada", hourStart: 14 }, userId: FIXED_USER_ID })).rejects.toThrow(/hora final/);
    await expect(createCityEdition(sdb, { fields: { name: "Errada", hourStart: 16, hourEnd: 14 }, userId: FIXED_USER_ID })).rejects.toThrow(/depois da inicial/);

    await updateCityEdition(sdb, {
      editionId: a.editionId,
      fields: { name: "Edição Círio 2026", slug: "vestida-para-o-cirio", openingLine: null, hourStart: 14, hourEnd: 16 },
      isActive: false,
      userId: FIXED_USER_ID,
    });
    const edited = await getCityEdition(sdb, a.editionId);
    expect(edited).toMatchObject({ name: "Edição Círio 2026", slug: "vestida-para-o-cirio", openingLine: null, startsOn: null, hourStart: 14, hourEnd: 16, isActive: false });

    // Slug pedido que já existe cai no sufixo; o próprio slug é mantido.
    await updateCityEdition(sdb, { editionId: b.editionId, fields: { name: "Outra", slug: "vestida-para-o-cirio" }, userId: FIXED_USER_ID });
    expect((await getCityEdition(sdb, b.editionId))?.slug).toBe("vestida-para-o-cirio-2");

    const audits = await db.select({ action: schema.auditLog.action }).from(schema.auditLog).where(eq(schema.auditLog.entityId, a.editionId));
    expect(audits.map((x) => x.action)).toEqual(["city_edition.create", "city_edition.update"]);
  });
});

describe("setCityEditionProducts / capa", () => {
  it("substitui as peças mantendo a ordem da lista; peça inexistente e mais de 40 são recusadas; capa vai para o Storage e a antiga sai", async () => {
    const { editionId } = await cirio();
    const p1 = await sellable("Longo Dunas", "DUNAS");
    const p2 = await sellable("Baby Look Bella", "BELLA");
    const p3 = await sellable("Saia Guamá", "GUAMA");

    await setCityEditionProducts(sdb, { editionId, productIds: [p2, p1, p2], userId: FIXED_USER_ID });
    expect((await getCityEdition(sdb, editionId))?.products.map((p) => [p.name, p.sortOrder])).toEqual([
      ["Baby Look Bella", 0],
      ["Longo Dunas", 1],
    ]);
    await setCityEditionProducts(sdb, { editionId, productIds: [p3], userId: FIXED_USER_ID });
    expect((await getCityEdition(sdb, editionId))?.products.map((p) => p.name)).toEqual(["Saia Guamá"]);
    expect((await listCityEditions(sdb))[0].productCount).toBe(1);

    await expect(
      setCityEditionProducts(sdb, { editionId, productIds: ["00000000-0000-4000-8000-000000000999"], userId: FIXED_USER_ID }),
    ).rejects.toMatchObject({ code: "peca_inexistente" });
    await expect(
      setCityEditionProducts(sdb, { editionId, productIds: Array.from({ length: 41 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`), userId: FIXED_USER_ID }),
    ).rejects.toMatchObject({ code: "edicao_muitas_pecas" });

    const storage = new FakeFileStorage();
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    const first = await setCityEditionCover(sdb, storage, { editionId, data: new Uint8Array(png), userId: FIXED_USER_ID, now: new Date("2026-09-20T12:00:00Z") });
    expect(first.coverPath).toBe(`city-editions/${editionId}/cover-${new Date("2026-09-20T12:00:00Z").getTime()}.jpg`);
    expect((await storage.download(first.coverPath)).contentType).toBe("image/jpeg");
    const second = await setCityEditionCover(sdb, storage, { editionId, data: new Uint8Array(png), userId: FIXED_USER_ID, now: new Date("2026-09-21T12:00:00Z") });
    expect((await getCityEdition(sdb, editionId))?.coverPath).toBe(second.coverPath);
    await expect(storage.download(first.coverPath)).rejects.toThrow();
    await expect(setCityEditionCover(sdb, storage, { editionId, data: new Uint8Array([1, 2, 3]), userId: FIXED_USER_ID })).rejects.toMatchObject({ code: "imagem_invalida" });
  });
});

describe("leitura pública", () => {
  it("vigente primeiro (hora > período), encerradas de fora, desativadas de fora; slug público; parágrafos e bairros", async () => {
    const cirioEd = await cirio();
    await createCityEdition(sdb, { isActive: true, fields: { name: "Chuva das 14h", hourStart: 14, hourEnd: 16 }, userId: FIXED_USER_ID });
    await createCityEdition(sdb, { isActive: true, fields: { name: "Sempre Belém", sortOrder: 9 }, userId: FIXED_USER_ID });
    const past = await createCityEdition(sdb, { isActive: true, fields: { name: "Natal 2025", startsOn: "2025-12-01", endsOn: "2025-12-25" }, userId: FIXED_USER_ID });
    // Só com fim + faixa de hora: aparece na lista mesmo fora da hora (só some quando encerra).
    await createCityEdition(sdb, { isActive: true, fields: { name: "Chuva até 12 out", endsOn: "2026-10-12", hourStart: 14, hourEnd: 16, sortOrder: 20 }, userId: FIXED_USER_ID });
    await createCityEdition(sdb, { fields: { name: "Escondida" }, userId: FIXED_USER_ID });

    const morning = await listPublicCityEditions(sdb, { now: IN_CIRIO });
    expect(morning.map((e) => [e.name, e.isCurrent])).toEqual([
      ["Edição Círio", true],
      ["Chuva das 14h", false],
      ["Sempre Belém", true],
      ["Chuva até 12 out", false],
    ]);
    expect((await getCurrentCityEdition(sdb, { now: IN_CIRIO }))?.name).toBe("Edição Círio");
    // 14h30 no Círio: período + hora é a mais específica e ganha da só-hora.
    expect((await getCurrentCityEdition(sdb, { now: new Date("2026-10-05T17:30:00Z") }))?.name).toBe("Chuva até 12 out");
    expect((await getCurrentCityEdition(sdb, { now: new Date("2026-10-20T17:30:00Z") }))?.name).toBe("Chuva das 14h");
    expect((await getCurrentCityEdition(sdb, { now: BEFORE }))?.name).toBe("Sempre Belém");
    // Fora do Círio às 9h: a permanente manda; o resto na ordem do painel (ordem, nome).
    expect((await listPublicCityEditions(sdb, { now: BEFORE })).map((e) => [e.name, e.daysUntil])).toEqual([
      ["Sempre Belém", null],
      ["Chuva das 14h", null],
      ["Edição Círio", 11],
      ["Chuva até 12 out", null],
    ]);
    expect(morning.map((e) => e.name)).not.toContain("Natal 2025");
    expect(morning.map((e) => e.name)).not.toContain("Escondida");

    const pub = await getPublicCityEditionBySlug(sdb, cirioEd.slug, { now: IN_CIRIO });
    expect(pub).toMatchObject({
      name: "Edição Círio",
      openingLine: "Vestida para o Círio",
      bodyParagraphs: ["Um parágrafo.", "Outro parágrafo."],
      districts: ["Nazaré", "Batista Campos", "Umarizal"],
      kind: "period",
      periodLabel: "1 out a 12 out",
      isCurrent: true,
      daysUntil: 0,
    });
    expect(await getPublicCityEditionBySlug(sdb, "escondida")).toBeNull();
    // Encerrada: a página some (404), como nas listas.
    expect(await getPublicCityEditionBySlug(sdb, "natal-2025", { now: IN_CIRIO })).toBeNull();
    expect(past.editionId).toBeTruthy();
  });

  it("listPublicProducts({ editionSlug }) devolve só as peças vendáveis da edição, na ordem da dona, sem duplicar", async () => {
    const { editionId, slug } = await cirio();
    const p1 = await sellable("Longo Dunas", "DUNAS");
    const p2 = await sellable("Baby Look Bella", "BELLA");
    await sellable("Fora da edição", "FORA");
    const { productId: draft } = await createTestVariant(db, { sku: "RASCUNHO", costCents: 1000, onHand: 3, name: "Sem preço" });
    await setCityEditionProducts(sdb, { editionId, productIds: [p2, p1, draft], userId: FIXED_USER_ID });

    const list = await listPublicProducts(sdb, { editionSlug: slug });
    expect(list.map((p) => p.name)).toEqual(["Baby Look Bella", "Longo Dunas"]);
    expect(await listPublicProducts(sdb, { editionSlug: "nao-existe" })).toEqual([]);
    expect((await listPublicProducts(sdb, {})).map((p) => p.name).sort()).toEqual(["Baby Look Bella", "Fora da edição", "Longo Dunas"]);
  });

  it("lançamento ligado à edição: a /estreia recebe a frase de abertura; edição desativada não vaza", async () => {
    const { editionId } = await cirio();
    const p1 = await sellable("Longo Dunas", "DUNAS");
    const publishAt = new Date(Date.now() + 3 * 3_600_000);
    const { dropId } = await createDrop(sdb, { name: "Estreia do Círio", publishAt, cityEditionId: editionId, userId: FIXED_USER_ID });
    await setDropProducts(sdb, { dropId, productIds: [p1], userId: FIXED_USER_ID });
    await db.update(schema.drops).set({ status: "scheduled" }).where(eq(schema.drops.id, dropId));
    expect((await getDrop(sdb, dropId))?.cityEditionId).toBe(editionId);

    const teaser = await getUpcomingDropTeaser(sdb);
    expect(teaser?.edition).toEqual({ name: "Edição Círio", slug: "edicao-cirio", openingLine: "Vestida para o Círio" });

    // Edição encerrada não empresta mais a frase.
    await updateCityEdition(sdb, { editionId, fields: { name: "Edição Círio", startsOn: "2025-10-01", endsOn: "2025-10-12" }, isActive: true, userId: FIXED_USER_ID });
    expect((await getUpcomingDropTeaser(sdb))?.edition).toBeNull();
    await updateCityEdition(sdb, { editionId, fields: { name: "Edição Círio" }, isActive: false, userId: FIXED_USER_ID });
    expect((await getUpcomingDropTeaser(sdb))?.edition).toBeNull();
  });
});

describe("planta da loja e a Lia", () => {
  it("listStoreMapEditions conta só peças vendáveis; resolveCityEditionSlug aceita slug, nome sem acento e pedaço; encerrada/desativada não resolve", async () => {
    const { editionId, slug } = await cirio();
    const p1 = await sellable("Longo Dunas", "DUNAS");
    const { productId: draft } = await createTestVariant(db, { sku: "RASCUNHO", costCents: 1000, onHand: 3, name: "Sem preço" });
    await setCityEditionProducts(sdb, { editionId, productIds: [p1, draft], userId: FIXED_USER_ID });
    await createCityEdition(sdb, { fields: { name: "Escondida" }, userId: FIXED_USER_ID });

    expect(await listStoreMapEditions(sdb, { now: IN_CIRIO })).toEqual([{ name: "Edição Círio", slug, productCount: 1, current: true, daysUntil: 0, kind: "period" }]);
    expect(await listStoreMapEditions(sdb, { now: BEFORE })).toEqual([{ name: "Edição Círio", slug, productCount: 1, current: false, daysUntil: 11, kind: "period" }]);


    expect(await resolveCityEditionSlug(sdb, "edicao-cirio", { now: BEFORE })).toEqual({ slug, name: "Edição Círio" });
    expect(await resolveCityEditionSlug(sdb, "EDICAO CIRIO", { now: BEFORE })).toEqual({ slug, name: "Edição Círio" });
    expect(await resolveCityEditionSlug(sdb, "círio", { now: BEFORE })).toEqual({ slug, name: "Edição Círio" });
    expect(await resolveCityEditionSlug(sdb, "edição do Círio", { now: BEFORE })).toEqual({ slug, name: "Edição Círio" });
    expect(await resolveCityEditionSlug(sdb, "Círio de Nazaré", { now: BEFORE })).toEqual({ slug, name: "Edição Círio" });
    expect(await resolveCityEditionSlug(sdb, "a", { now: BEFORE })).toBeNull();
    expect(await resolveCityEditionSlug(sdb, "edição", { now: BEFORE })).toBeNull();
    expect(await resolveCityEditionSlug(sdb, "carnaval", { now: BEFORE })).toBeNull();
    expect(await resolveCityEditionSlug(sdb, "escondida", { now: BEFORE })).toBeNull();
    expect(await resolveCityEditionSlug(sdb, "círio", { now: new Date("2026-11-01T12:00:00Z") })).toBeNull();

    expect(await summarizeCityEditionsForDigest(sdb, { now: BEFORE })).toEqual([
      { name: "Edição Círio", isCurrent: false, daysUntil: 11, kind: "period", hours: null, products: 2, missingPhoto: 2 },
    ]);
    // Edição sem peça vendável fica fora da planta (mas o Bom dia ainda a vê).
    await createCityEdition(sdb, { isActive: true, fields: { name: "Vazia" }, userId: FIXED_USER_ID });
    expect((await listStoreMapEditions(sdb, { now: BEFORE })).map((e) => e.name)).toEqual(["Edição Círio"]);
  });
});
