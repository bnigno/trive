// O cartão do Ateliê: a foto da ficha vira a imagem noir/ouro com o resumo
// da chegada e vai para a dona com o link na legenda; sem foto, nada sai;
// a reentrada reaproveita o cartão e não manda duas vezes.
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeFileStorage } from "@/adapters/storage/fake";
import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import type { CardData } from "@/core/cards/types";
import * as schema from "@/db/schema";
import { initialWaTemplates } from "@/db/seed-data";
import { formatCentsBRL } from "@/lib/money";
import type { DbOrTx } from "@/queue/enqueue";
import { renderAndSendAtelierCard } from "@/services/atelier-card";
import { createTestDb, createTestSupplier, FIXED_USER_ID, type TestDb } from "../helpers/db";

const OWNER = "+5591981037536";
const NOW = new Date("2026-09-13T18:00:00Z");

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;
let provider: FakeMessagingProvider;
let storage: FakeFileStorage;
const rendered: CardData[] = [];
const render = async (data: CardData): Promise<Buffer> => {
  rendered.push(data);
  return sharp({ create: { width: 108, height: 135, channels: 3, background: "#111" } }).png().toBuffer();
};

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  provider = new FakeMessagingProvider();
  storage = new FakeFileStorage();
  rendered.length = 0;
  vi.stubEnv("ADAPTER_MODE", "fake");
  await db.insert(schema.settings).values([
    { key: "wa_enabled", value: true },
    { key: "owner_whatsapp_phone", value: OWNER },
  ]);
  await db.insert(schema.waTemplates).values(
    initialWaTemplates
      .filter((template) => template.key === "owner_atelier_card")
      .map((template) => ({ key: template.key, label: template.label, bodyTemplate: template.bodyTemplate, variables: template.variables })),
  );
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
});

async function seedIntake(opts: { withPhoto?: boolean; withPurchase?: boolean } = {}): Promise<{ intakeId: string; productId: string }> {
  const [conversation] = await db.insert(schema.waConversations).values({ phoneE164: OWNER, status: "open" }).returning({ id: schema.waConversations.id });
  const [message] = await db
    .insert(schema.waMessages)
    .values({ conversationId: conversation.id, direction: "inbound", kind: "text", zapiMessageId: "MSG-NOTE", body: "chegou o Longo Dunas", status: "delivered" })
    .returning({ id: schema.waMessages.id });
  const [product] = await db.insert(schema.products).values({ name: "Longo Dunas", slug: "longo-dunas" }).returning({ id: schema.products.id });
  if (opts.withPhoto !== false) {
    const jpeg = await sharp({ create: { width: 600, height: 800, channels: 3, background: "#b08968" } }).jpeg().toBuffer();
    await storage.upload({ path: "products/longo-dunas/foto.jpg", data: jpeg, contentType: "image/jpeg" });
    await db.insert(schema.productImages).values({ productId: product.id, storagePath: "products/longo-dunas/foto.jpg", sortOrder: 0 });
  }
  let supplierId: string | null = null;
  let financialEntryId: string | null = null;
  if (opts.withPurchase) {
    supplierId = await createTestSupplier(db, { name: "Aurora" });
    const [entry] = await db
      .insert(schema.financialEntries)
      .values({ direction: "payable", category: "supplier", description: "Compra", amountCents: 288000, status: "pending", supplierId, createdBy: FIXED_USER_ID })
      .returning({ id: schema.financialEntries.id });
    financialEntryId = entry.id;
  }
  const [intake] = await db
    .insert(schema.atelierIntakes)
    .values({
      conversationId: conversation.id,
      triggerWaMessageId: message.id,
      note: "chegou o Longo Dunas",
      status: "done",
      productId: product.id,
      supplierId,
      financialEntryId,
      parsed: {
        proposal: {
          name: "Longo Dunas",
          categoryId: null,
          categoryName: null,
          description: "",
          composition: "",
          careSymbols: [],
          careFreeText: [],
          fitNotes: "",
          colors: ["Areia", "Terra"],
          sizes: ["P", "M", "G", "GG"],
          variantCount: 8,
          quantityPerVariant: 3,
          totalQuantity: 24,
          unitCostCents: 12000,
          totalCostCents: 288000,
          costBasis: "per_piece",
          supplierName: "Aurora",
          weightGrams: null,
          warnings: [],
        },
        suggestedPriceCents: 28990,
        model: "claude-sonnet-5",
        usage: null,
        estimatedCostUsdCents: 0,
        ms: 10,
        failed: null,
      },
    })
    .returning({ id: schema.atelierIntakes.id });
  return { intakeId: intake.id, productId: product.id };
}

describe("renderAndSendAtelierCard", () => {
  it("desenha o cartão com a foto e o resumo, guarda no Storage e manda à dona com a legenda", async () => {
    const { intakeId, productId } = await seedIntake({ withPurchase: true });
    const result = await renderAndSendAtelierCard(sdb, provider, storage, render, { intakeId }, { now: () => NOW });
    expect("cardUrl" in result && result.cardUrl).toBe(`memory://atelier/${intakeId}/card-${NOW.getTime()}.jpg`);

    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toMatchObject({
      kind: "atelier",
      eyebrow: "ATELIÊ · RASCUNHO PRONTO",
      title: "Longo Dunas",
      hero: { slug: "longo-dunas", priceLabel: `sugerido ${formatCentsBRL(28990)}` },
      lines: ["2 cores × 4 tamanhos", `24 peças · custo ${formatCentsBRL(12000)}`, `Aurora · a pagar ${formatCentsBRL(288000)}`],
    });
    expect(storage.has(`atelier/${intakeId}/card-${NOW.getTime()}.jpg`)).toBe(true);
    const [intake] = await db.select().from(schema.atelierIntakes).where(eq(schema.atelierIntakes.id, intakeId));
    expect(intake.cardPath).toBe(`atelier/${intakeId}/card-${NOW.getTime()}.jpg`);

    expect(provider.sentImages).toHaveLength(1);
    expect(provider.sentImages[0].toE164).toBe(OWNER);
    expect(provider.sentImages[0].imageUrl).toBe(`memory://atelier/${intakeId}/card-${NOW.getTime()}.jpg`);
    expect(provider.sentImages[0].caption).toContain("🧵 Longo Dunas · 2 cores × 4 tamanhos · 3 de cada (24 peças)");
    expect(provider.sentImages[0].caption).toContain(`/admin/produtos/${productId}`);

    // Reentrada: nem desenha de novo nem manda de novo.
    const again = await renderAndSendAtelierCard(sdb, provider, storage, render, { intakeId }, { now: () => new Date(NOW.getTime() + 60_000) });
    expect("cardUrl" in again && again.cardUrl).toBe(`memory://atelier/${intakeId}/card-${NOW.getTime()}.jpg`);
    expect(rendered).toHaveLength(1);
    expect(provider.sentImages).toHaveLength(1);
  });

  it("ficha sem foto: nada sai (o texto já foi)", async () => {
    const { intakeId } = await seedIntake({ withPhoto: false });
    expect(await renderAndSendAtelierCard(sdb, provider, storage, render, { intakeId })).toEqual({ skipped: "sem_foto" });
    expect(rendered).toHaveLength(0);
    expect(provider.sentImages).toHaveLength(0);
  });

  it("foto que sumiu do Storage: também pula, sem lançar", async () => {
    const { intakeId } = await seedIntake();
    storage.reset();
    expect(await renderAndSendAtelierCard(sdb, provider, storage, render, { intakeId })).toEqual({ skipped: "sem_foto" });
  });
});
