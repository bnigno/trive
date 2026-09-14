// A Lia sugere o tamanho (PGlite + fakes): sem medidas orienta a pedir;
// atualizar_cartela.medidas guarda em coluna própria (nunca no perfil nem
// no caderninho); sugerir_tamanho responde em folga; anotar recusa medidas.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { buildToolExecutor } from "@/services/wa-bot";
import { loadMemoryLines } from "@/services/bot/style";
import { getBodyMeasurements } from "@/services/style-profiles";
import { createTestDb, type TestDb } from "../helpers/db";

const PHONE = "+5511999990000";
const INBOUND = "00000000-0000-4000-8000-0000000000aa";

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

async function seedDunas(): Promise<string> {
  const [product] = await db.insert(schema.products).values({ name: "Longo Dunas", slug: "longo-dunas", status: "active", attributesSchema: ["cor", "tamanho"] }).returning({ id: schema.products.id });
  const rows = [
    ["P", { bust: 88, waist: 70, hip: 94 }],
    ["M", { bust: 94, waist: 76, hip: 100 }],
    ["G", { bust: 100, waist: 82, hip: 106 }],
  ] as const;
  for (const [size, measurements] of rows) {
    const [variant] = await db.insert(schema.productVariants).values({ productId: product.id, sku: `LD-${size}`, attributes: { cor: "Areia", tamanho: size }, costCents: 100, measurements }).returning({ id: schema.productVariants.id });
    await db.insert(schema.stockLevels).values({ productVariantId: variant.id, onHand: 3, reserved: 0 });
    await db.insert(schema.priceVersions).values({ productVariantId: variant.id, versionNumber: 1, status: "active", priceCents: 28900, origin: "initial", breakdown: {}, costSnapshotCents: 100, computedMarginRate: "0.3000", activatedAt: new Date() });
  }
  const [conversation] = await db.insert(schema.waConversations).values({ phoneE164: PHONE, status: "open" }).returning({ id: schema.waConversations.id });
  return conversation.id;
}

describe("sugerir_tamanho", () => {
  it("sem medidas orienta a pedir; medidas guardadas pela cartela ficam fora do caderninho; a resposta fala em folga", async () => {
    const conversationId = await seedDunas();
    const executor = buildToolExecutor(sdb, { conversationId, phoneE164: PHONE, customerId: null, lastInboundId: INBOUND });
    const first = await executor("sugerir_tamanho", { produto: "longo-dunas" });
    expect(first.ok).toBe(false);
    expect(first.text).toContain("atualizar_cartela.medidas");

    const saved = await executor("atualizar_cartela", { caimento: "fluido", medidas: { busto_cm: 88, cintura_cm: 72, quadril_cm: 96 } });
    expect(saved.ok).toBe(true);
    expect(saved.text).toContain("Medidas guardadas");
    expect(saved.text).not.toMatch(/\b88\b/);
    expect((await getBodyMeasurements(sdb, { phoneE164: PHONE }))?.body).toEqual({ bustCm: 88, waistCm: 72, hipsCm: 96 });
    const [profile] = await db.select().from(schema.customerProfiles).where(eq(schema.customerProfiles.phoneE164, PHONE));
    expect(JSON.stringify(profile.profile)).not.toMatch(/\b88\b/);
    const lines = await loadMemoryLines(sdb, PHONE);
    expect(lines.join(" ")).toContain("medidas do corpo guardadas");
    expect(lines.join(" ")).not.toMatch(/\b(88|72|96)\b/);

    const advice = await executor("sugerir_tamanho", { produto: "Longo Dunas" });
    expect(advice.ok).toBe(true);
    expect(advice.text).toContain("Eu iria de G.");
    expect(advice.text).toContain("folga");
    expect(advice.text).not.toMatch(/\b88\b/);
    expect((await executor("sugerir_tamanho", { produto: "nao-existe" })).ok).toBe(false);
    // Medida de 30 cm não passa no schema; anotar recusa medidas.
    expect((await executor("atualizar_cartela", { medidas: { busto_cm: 30 } })).ok).toBe(false);
    const note = await executor("anotar", { nota: "busto 88, cintura 72" });
    expect(note.ok).toBe(false);
    expect(note.text).toContain("atualizar_cartela.medidas");
  });

  it("no ensaio (dryRun) sugerir_tamanho consulta mas atualizar_cartela não grava", async () => {
    const conversationId = await seedDunas();
    const dry = buildToolExecutor(sdb, { conversationId, phoneE164: PHONE, customerId: null, lastInboundId: INBOUND, dryRun: true });
    expect((await dry("atualizar_cartela", { medidas: { busto_cm: 88 } })).ok).toBe(true);
    expect(await getBodyMeasurements(sdb, { phoneE164: PHONE })).toBeNull();
    expect((await dry("sugerir_tamanho", { produto: "longo-dunas" })).ok).toBe(false);
  });
});
