// A ficha recusou a proposta (validação do catálogo): a peça nasce simples,
// SEM compra pela grade antiga (nem 3 peças nem conta de R$ 360), e a
// mensagem diz que a grade ficou para o painel.
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeSalesAssistant } from "@/adapters/assistant/fake";
import { FakeFileStorage } from "@/adapters/storage/fake";
import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import { INBOUND_MEDIA_MARKERS } from "@/core/whatsapp/media";
import * as schema from "@/db/schema";
import { initialWaTemplates } from "@/db/seed-data";
import type { DbOrTx } from "@/queue/enqueue";
import { createTestDb, type TestDb } from "../helpers/db";

vi.mock("@/services/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/catalog")>();
  let calls = 0;
  return {
    ...actual,
    createProduct: vi.fn(async (db: Parameters<typeof actual.createProduct>[0], input: Parameters<typeof actual.createProduct>[1]) => {
      calls += 1;
      // A primeira chamada (com a grade) é recusada como a ficha recusaria.
      if (calls === 1) throw new actual.ServiceError("descricao_longa", "Descrição: no máximo 1200 caracteres.");
      return actual.createProduct(db, input);
    }),
  };
});

const { openAtelierIntake, processAtelierIntake } = await import("@/services/atelier");

const OWNER = "+5591981037536";
const NOW = new Date("2026-09-13T18:00:00Z");

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  vi.stubEnv("ADAPTER_MODE", "fake");
  await db.insert(schema.settings).values([
    { key: "wa_enabled", value: true },
    { key: "owner_whatsapp_phone", value: OWNER },
  ]);
  await db.insert(schema.waTemplates).values(
    initialWaTemplates
      .filter((template) => template.key.startsWith("owner_atelier_"))
      .map((template) => ({ key: template.key, label: template.label, bodyTemplate: template.bodyTemplate, variables: template.variables })),
  );
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
});

describe("ficha recusou a proposta", () => {
  it("peça simples sem compra pela grade antiga; aviso honesto", async () => {
    const provider = new FakeMessagingProvider();
    const storage = new FakeFileStorage();
    const assistant = new FakeSalesAssistant();
    assistant.enqueueExtraction({
      name: "Longo Dunas",
      categorySlug: null,
      description: "x".repeat(320),
      composition: "",
      careSymbols: [],
      careFreeText: "",
      fitNotes: "",
      colors: ["Areia", "Terra"],
      sizes: ["P", "M", "G", "GG"],
      sizeRange: null,
      quantityPerVariant: 3,
      totalQuantity: null,
      costCents: 12000,
      costBasis: "per_piece",
      supplierName: "Aurora",
      weightGramsEstimate: null,
      warnings: [],
    });

    const [conversation] = await db.insert(schema.waConversations).values({ phoneE164: OWNER, status: "open" }).returning({ id: schema.waConversations.id });
    const url = "https://cdn.z-api/foto.jpg";
    provider.setMediaFixture(url, await sharp({ create: { width: 64, height: 80, channels: 3, background: "#c8a27a" } }).jpeg().toBuffer(), "image/jpeg");
    await db.insert(schema.waMessages).values({
      conversationId: conversation.id,
      direction: "inbound",
      kind: "image",
      zapiMessageId: "MSG-F",
      body: INBOUND_MEDIA_MARKERS.image,
      mediaUrl: url,
      status: "delivered",
      createdAt: new Date(NOW.getTime() - 60_000),
    });
    const [note] = await db
      .insert(schema.waMessages)
      .values({ conversationId: conversation.id, direction: "inbound", kind: "text", zapiMessageId: "MSG-N", body: "chegou o Longo Dunas da Aurora, três de cada, custou 120", status: "delivered", createdAt: NOW })
      .returning({ id: schema.waMessages.id });
    await openAtelierIntake(sdb, { conversationId: conversation.id, phoneE164: OWNER, triggerWaMessageId: note.id, zapiMessageId: "MSG-N", kind: "text", body: "chegou o Longo Dunas da Aurora, três de cada, custou 120", now: NOW });

    const result = await processAtelierIntake(sdb, provider, storage, assistant, { conversationId: conversation.id, triggerWaMessageId: note.id }, { now: () => new Date(NOW.getTime() + 60_000) });
    expect(result).toMatchObject({ created: true, name: "Longo Dunas", interpreted: false });

    const variants = await db.select().from(schema.productVariants);
    expect(variants).toHaveLength(1);
    expect(await db.select().from(schema.stockMovements)).toHaveLength(0);
    expect(await db.select().from(schema.financialEntries)).toHaveLength(0);
    expect(await db.select().from(schema.suppliers)).toHaveLength(0);

    const [intake] = await db.select().from(schema.atelierIntakes);
    const parsed = intake.parsed as { failed: string; proposal: unknown; purchase: { skipped: string } };
    expect(parsed.failed).toBe("ficha_recusou");
    expect(parsed.proposal).toBeNull();
    expect(parsed.purchase.skipped).toBe("sem_proposta");
    expect(provider.sentMessages[0].body).toContain("a ficha recusou a grade: peça simples");
    expect(provider.sentMessages[0].body).not.toContain("a pagar");
    expect(provider.sentMessages[0].body).not.toContain("2 cores");
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "atelier.intake"));
    expect(audits[0].after).toMatchObject({ interpreted: false, interpretationFailed: "ficha_recusou", variants: 1 });
  });
});
