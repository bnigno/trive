// "Vai me servir?" com PGlite: as medidas entram na cartela (coluna própria,
// nunca no perfil), o veredito lê a tabela da peça, "apagar minhas medidas"
// e "esquecer a cartela" zeram, e a Lia só fica sabendo QUE existem.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { adviseSizeForProduct } from "@/services/fit-advice";
import { forgetBodyMeasurements, forgetStyleProfile, getBodyMeasurements, getStyleProfileByToken, saveBodyMeasurements, saveStyleProfile } from "@/services/style-profiles";
import { loadMemoryLines } from "@/services/bot/style";
import { createTestDb, type TestDb } from "../helpers/db";

const PHONE = "+5511999990000";

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  vi.stubEnv("ADAPTER_MODE", "fake");
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
});

async function seedDunas(): Promise<void> {
  const [product] = await db.insert(schema.products).values({ name: "Longo Dunas", slug: "longo-dunas", status: "active", attributesSchema: ["cor", "tamanho"] }).returning({ id: schema.products.id });
  const rows = [
    ["P", { bust: 88, waist: 70, hip: 94 }],
    ["M", { bust: 94, waist: 76, hip: 100 }],
    ["G", { bust: 100, waist: 82, hip: 106 }],
  ] as const;
  for (const [size, measurements] of rows) {
    const [variant] = await db.insert(schema.productVariants).values({ productId: product.id, sku: `LD-${size}`, attributes: { cor: "Areia", tamanho: size }, costCents: 100, measurements }).returning({ id: schema.productVariants.id });
    await db.insert(schema.priceVersions).values({ productVariantId: variant.id, versionNumber: 1, status: "active", priceCents: 28900, origin: "initial", breakdown: {}, costSnapshotCents: 100, computedMarginRate: "0.3000", activatedAt: new Date() });
  }
  // Uma variação sem preço (fora da vitrine) com tabela absurda: não pode entrar no veredito.
  await db.insert(schema.productVariants).values({ productId: product.id, sku: "LD-XX", attributes: { cor: "Areia", tamanho: "XG" }, costCents: 100, measurements: { bust: 200, waist: 200, hip: 200 } });
}

describe("Vai me servir?", () => {
  it("sem cartela não há onde guardar; com cartela guarda uma vez, o veredito lê a tabela e o caimento da cartela", async () => {
    await seedDunas();
    expect(await saveBodyMeasurements(sdb, { siteToken: "00000000-0000-4000-8000-000000000001", body: { bustCm: 88 } })).toMatchObject({ saved: false, reason: "sem_cartela" });
    const profile = await saveStyleProfile(sdb, { phoneE164: PHONE, patch: { fit: "fluido" }, source: "quiz", consent: true });
    expect(await adviseSizeForProduct(sdb, { slug: "longo-dunas", siteToken: profile.siteToken })).toMatchObject({ advice: { kind: "no_body" }, hasChart: true });

    const saved = await saveBodyMeasurements(sdb, { siteToken: profile.siteToken, body: { bustCm: 88, waistCm: 72, hipsCm: 96 } });
    expect(saved.saved).toBe(true);
    const bodyToken = saved.bodyToken as string;
    expect(bodyToken).toMatch(/^[0-9a-f-]{36}$/);
    // Pelo site, ler/trocar/apagar exige a credencial das medidas — o token da cartela sozinho não basta.
    expect(await getBodyMeasurements(sdb, { siteToken: profile.siteToken })).toBeNull();
    expect((await adviseSizeForProduct(sdb, { slug: "longo-dunas", siteToken: profile.siteToken })).advice).toEqual({ kind: "no_body" });
    expect(await saveBodyMeasurements(sdb, { siteToken: profile.siteToken, body: { bustCm: 120 } })).toMatchObject({ saved: false, reason: "sem_credencial" });
    expect(await forgetBodyMeasurements(sdb, { siteToken: profile.siteToken })).toEqual({ forgotten: false });
    const stored = await getBodyMeasurements(sdb, { siteToken: profile.siteToken, bodyToken });
    expect(stored?.body).toEqual({ bustCm: 88, waistCm: 72, hipsCm: 96 });
    // Trocar com a credencial mantém a mesma credencial.
    expect(await saveBodyMeasurements(sdb, { siteToken: profile.siteToken, bodyToken, body: { bustCm: 88, waistCm: 72, hipsCm: 96 } })).toEqual({ saved: true, bodyToken });
    // A coluna do perfil não ganha as medidas.
    const [row] = await db.select().from(schema.customerProfiles).where(eq(schema.customerProfiles.id, profile.id));
    expect(row.profile).toEqual(expect.not.objectContaining({ bustCm: expect.anything() }));
    expect(JSON.stringify(row.profile)).not.toMatch(/\b88\b/);
    expect(row.bodyMeasuredAt).not.toBeNull();

    const view = await adviseSizeForProduct(sdb, { slug: "longo-dunas", siteToken: profile.siteToken, bodyToken });
    expect(view.advice).toMatchObject({ kind: "advice", recommended: "G", fit: "fluido" });
    if (view.advice.kind === "advice") expect(view.advice.verdicts.map((verdict) => verdict.size)).toEqual(["P", "M", "G"]);
    expect(view.text).toContain("Eu iria de G.");
    // Pelo telefone (a Lia) o mesmo veredito.
    expect((await adviseSizeForProduct(sdb, { slug: "longo-dunas", phoneE164: PHONE })).advice).toMatchObject({ kind: "advice", recommended: "G" });
    // Peça sem tabela.
    await db.insert(schema.products).values({ name: "Lenço", slug: "lenco", status: "active", attributesSchema: ["cor"] });
    expect((await adviseSizeForProduct(sdb, { slug: "lenco", siteToken: profile.siteToken })).advice).toEqual({ kind: "no_chart" });

    // A Lia sabe QUE existem, nunca os números; o painel idem (view).
    const lines = await loadMemoryLines(sdb, PHONE);
    expect(lines.join(" ")).toContain("medidas do corpo guardadas");
    expect(lines.join(" ")).not.toMatch(/\b88\b/);
    expect((await getStyleProfileByToken(sdb, profile.siteToken))?.hasBodyMeasurements).toBe(true);

    // Apagar só as medidas (com a credencial): a cartela fica.
    expect(await forgetBodyMeasurements(sdb, { siteToken: profile.siteToken, bodyToken })).toEqual({ forgotten: true });
    expect(await forgetBodyMeasurements(sdb, { siteToken: profile.siteToken, bodyToken })).toEqual({ forgotten: false });
    expect(await getBodyMeasurements(sdb, { siteToken: profile.siteToken, bodyToken })).toBeNull();
    expect(await getBodyMeasurements(sdb, { phoneE164: PHONE })).toBeNull();
    expect((await getStyleProfileByToken(sdb, profile.siteToken))?.profile.fit).toBe("fluido");

    // Esquecer a cartela zera as medidas também.
    await saveBodyMeasurements(sdb, { siteToken: profile.siteToken, body: { bustCm: 90 } });
    await forgetStyleProfile(sdb, { siteToken: profile.siteToken });
    const [gone] = await db.select().from(schema.customerProfiles).where(eq(schema.customerProfiles.id, profile.id));
    expect(gone.bodyMeasurements).toBeNull();
    const audits = (await db.select().from(schema.auditLog)).map((entry) => entry.action);
    expect(audits).toEqual(expect.arrayContaining(["style.body_measurements_save", "style.body_measurements_forget"]));
    // A trilha diz que mudou, nunca os números (os uuids podem conter "88": olhe só o `after`).
    for (const entry of await db.select().from(schema.auditLog)) {
      if (String(entry.action).startsWith("style.body_measurements")) expect(JSON.stringify(entry.after)).not.toMatch(/\b(88|90|72|96)\b/);
    }
  });
});
