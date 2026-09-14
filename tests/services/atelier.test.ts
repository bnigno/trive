// A montagem da chegada na fila: as fotos da dona viram um rascunho com as
// fotos publicadas e ela recebe "Rascunho pronto · … · N fotos" com o link.
// Reentrega não duplica; foto expirada e recado sem fotos viram orientação.
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AssistantUnavailableError } from "@/adapters/assistant";
import { FakeSalesAssistant } from "@/adapters/assistant/fake";
import { FakeFileStorage } from "@/adapters/storage/fake";
import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import { INBOUND_MEDIA_MARKERS } from "@/core/whatsapp/media";
import * as schema from "@/db/schema";
import { initialWaTemplates } from "@/db/seed-data";
import { formatCentsBRL } from "@/lib/money";
import type { DbOrTx } from "@/queue/enqueue";
import {
  getAtelierIntakeForProduct,
  openAtelierIntake,
  processAtelierIntake,
} from "@/services/atelier";
import { createTestDb, createTestFeeRuleAndPolicy, type TestDb } from "../helpers/db";

const OWNER = "+5591981037536";
const NOW = new Date("2026-09-13T18:00:00Z");

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;
let provider: FakeMessagingProvider;
let storage: FakeFileStorage;
let assistant: FakeSalesAssistant;

async function jpeg(color: string): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 80, channels: 3, background: color } }).jpeg().toBuffer();
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  provider = new FakeMessagingProvider();
  storage = new FakeFileStorage();
  // Sem roteiro, o fake devolve a chegada mínima (nome pelo recado, sem
  // grade, sem custo): a ficha nasce simples, como no C-A.
  assistant = new FakeSalesAssistant();
  vi.stubEnv("ADAPTER_MODE", "fake");
  await db.insert(schema.settings).values([
    { key: "wa_enabled", value: true },
    { key: "owner_whatsapp_phone", value: OWNER },
  ]);
  await db.insert(schema.waTemplates).values(
    initialWaTemplates
      .filter((template) => template.key.startsWith("owner_atelier_"))
      .map((template) => ({
        key: template.key,
        label: template.label,
        bodyTemplate: template.bodyTemplate,
        variables: template.variables,
      })),
  );
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
});

async function seedConversation(): Promise<string> {
  const [conversation] = await db
    .insert(schema.waConversations)
    .values({ phoneE164: OWNER, status: "open" })
    .returning({ id: schema.waConversations.id });
  return conversation.id;
}

async function seedInbound(
  conversationId: string,
  input: { kind: "image" | "text" | "audio"; body: string; mediaUrl?: string; at: Date; zapiId: string },
): Promise<string> {
  const [message] = await db
    .insert(schema.waMessages)
    .values({
      conversationId,
      direction: "inbound",
      kind: input.kind,
      zapiMessageId: input.zapiId,
      body: input.body,
      ...(input.mediaUrl ? { mediaUrl: input.mediaUrl } : {}),
      status: "delivered",
      deliveredAt: input.at,
      createdAt: input.at,
    })
    .returning({ id: schema.waMessages.id });
  return message.id;
}

/** Duas fotos (com fixture) e o recado, como a Z-API entrega. */
async function seedArrival(note = "chegou o Longo Dunas da Aurora, custou 120"): Promise<{
  conversationId: string;
  photoIds: string[];
  noteId: string;
}> {
  const conversationId = await seedConversation();
  const photoIds: string[] = [];
  for (const [index, color] of ["#c8a27a", "#5a4a3a"].entries()) {
    const url = `https://cdn.z-api/foto-${index}.jpg`;
    provider.setMediaFixture(url, await jpeg(color), "image/jpeg");
    photoIds.push(
      await seedInbound(conversationId, {
        kind: "image",
        body: INBOUND_MEDIA_MARKERS.image,
        mediaUrl: url,
        at: new Date(NOW.getTime() - (120 - index * 30) * 1000),
        zapiId: `MSG-FOTO-${index}`,
      }),
    );
  }
  const noteId = await seedInbound(conversationId, { kind: "text", body: note, at: NOW, zapiId: "MSG-NOTE" });
  await openAtelierIntake(sdb, {
    conversationId,
    phoneE164: OWNER,
    triggerWaMessageId: noteId,
    zapiMessageId: "MSG-NOTE",
    kind: "text",
    body: note,
    now: NOW,
  });
  return { conversationId, photoIds, noteId };
}

const clock = { now: () => new Date(NOW.getTime() + 60_000) };

describe("processAtelierIntake", () => {
  it("fotos + recado viram rascunho com as fotos e a dona recebe o link", async () => {
    const { conversationId, photoIds, noteId } = await seedArrival();
    const result = await processAtelierIntake(sdb, provider, storage, assistant, { conversationId, triggerWaMessageId: noteId }, clock);
    expect(result).toMatchObject({ created: true, name: "Longo Dunas", photos: 2, failedPhotos: 0 });
    if (!("created" in result)) throw new Error("esperava created");

    const [product] = await db.select().from(schema.products).where(eq(schema.products.id, result.productId));
    expect(product.name).toBe("Longo Dunas");
    expect(product.status).toBe("draft");
    expect(product.description).toContain("Recado da chegada: chegou o Longo Dunas");
    const variants = await db.select().from(schema.productVariants).where(eq(schema.productVariants.productId, product.id));
    expect(variants.map((variant) => variant.sku)).toEqual(["LONGO-DUNAS"]);
    const images = await db.select().from(schema.productImages).where(eq(schema.productImages.productId, product.id));
    expect(images).toHaveLength(2);
    // full + md + thumb de cada foto no bucket.
    expect(storage.list().length).toBeGreaterThanOrEqual(6);

    const [intake] = await db.select().from(schema.atelierIntakes);
    expect(intake).toMatchObject({ status: "done", productId: product.id, photosCount: 2, noteKind: "text" });
    expect(intake.photoWaMessageIds).toEqual(photoIds);
    expect(intake.uploadedWaMessageIds).toEqual(photoIds);
    expect(await getAtelierIntakeForProduct(sdb, product.id)).toMatchObject({ id: intake.id, photosCount: 2 });

    expect(provider.sentMessages).toHaveLength(1);
    expect(provider.sentMessages[0].toE164).toBe(OWNER);
    expect(provider.sentMessages[0].body).toContain("Rascunho pronto · Longo Dunas · 2 fotos");
    expect(provider.sentMessages[0].body).toContain(`/admin/produtos/${product.id}`);

    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "atelier.intake"));
    expect(audits).toHaveLength(1);
    expect(audits[0].after).toMatchObject({ productId: product.id, photos: 2, failedPhotos: 0 });
  });

  it("rodar de novo (reentrega/retry) não cria segundo produto nem segunda mensagem", async () => {
    const { conversationId, noteId } = await seedArrival();
    await processAtelierIntake(sdb, provider, storage, assistant, { conversationId, triggerWaMessageId: noteId }, clock);
    const again = await processAtelierIntake(sdb, provider, storage, assistant, { conversationId, triggerWaMessageId: noteId, attempt: 1 }, clock);
    expect(again).toEqual({ skipped: "ja_processado" });
    expect(await db.select().from(schema.products)).toHaveLength(1);
    expect(provider.sentMessages).toHaveLength(1);
  });

  it("SKU já existente ganha sufixo", async () => {
    const [product] = await db.insert(schema.products).values({ name: "Outro", slug: "outro" }).returning();
    await db.insert(schema.productVariants).values({ productId: product.id, sku: "LONGO-DUNAS", attributes: {} });
    const { conversationId, noteId } = await seedArrival();
    const result = await processAtelierIntake(sdb, provider, storage, assistant, { conversationId, triggerWaMessageId: noteId }, clock);
    if (!("created" in result)) throw new Error("esperava created");
    const variants = await db.select().from(schema.productVariants).where(eq(schema.productVariants.productId, result.productId));
    expect(variants[0].sku).toBe("LONGO-DUNAS-2");
  });

  it("todas as fotos expiradas na Z-API: nada é criado e a dona recebe a orientação", async () => {
    const { conversationId, noteId } = await seedArrival();
    provider.reset();
    const result = await processAtelierIntake(sdb, provider, storage, assistant, { conversationId, triggerWaMessageId: noteId }, clock);
    expect(result).toMatchObject({ failed: "fotos_indisponiveis" });
    expect(await db.select().from(schema.products)).toHaveLength(0);
    const [intake] = await db.select().from(schema.atelierIntakes);
    expect(intake.status).toBe("failed");
    expect(intake.errorDetail).toBe("fotos_indisponiveis");
    expect(provider.sentMessages).toHaveLength(1);
    expect(provider.sentMessages[0].body).toContain("mande as fotos primeiro");
    expect(provider.sentMessages[0].body).toContain("não estão mais disponíveis");
  });

  it("uma foto que não baixa fica de fora, o rascunho sai com as outras", async () => {
    const { conversationId, noteId } = await seedArrival();
    provider.reset();
    provider.setMediaFixture("https://cdn.z-api/foto-1.jpg", await jpeg("#5a4a3a"), "image/jpeg");
    const result = await processAtelierIntake(sdb, provider, storage, assistant, { conversationId, triggerWaMessageId: noteId }, clock);
    expect(result).toMatchObject({ created: true, photos: 1, failedPhotos: 1 });
    const [intake] = await db.select().from(schema.atelierIntakes);
    expect(intake.errorDetail).toBe("1 foto(s) ficaram de fora");
    expect(provider.sentMessages[0].body).toContain("· 1 foto");
  });

  it("recado sem foto nos últimos 15 minutos: orientação, sem produto", async () => {
    const conversationId = await seedConversation();
    const noteId = await seedInbound(conversationId, { kind: "text", body: "chegou o vestido", at: NOW, zapiId: "MSG-SO-TEXTO" });
    await openAtelierIntake(sdb, {
      conversationId,
      phoneE164: OWNER,
      triggerWaMessageId: noteId,
      zapiMessageId: "MSG-SO-TEXTO",
      kind: "text",
      body: "chegou o vestido",
      now: NOW,
    });
    const result = await processAtelierIntake(sdb, provider, storage, assistant, { conversationId, triggerWaMessageId: noteId }, clock);
    expect(result).toMatchObject({ failed: "sem_fotos" });
    expect(await db.select().from(schema.products)).toHaveLength(0);
    expect(provider.sentMessages[0].body).toContain("Não achei fotos suas");
  });

  it("Ateliê desligado: a chegada já aberta não é montada", async () => {
    await db.insert(schema.settings).values({ key: "atelier_enabled", value: false });
    const { conversationId, noteId } = await seedArrival();
    const result = await processAtelierIntake(sdb, provider, storage, assistant, { conversationId, triggerWaMessageId: noteId }, clock);
    expect(result).toEqual({ skipped: "desligado" });
    expect(provider.sentMessages).toHaveLength(0);
  });

  it("abrir a chegada duas vezes com o mesmo recado (reentrega do webhook) não duplica", async () => {
    const { conversationId, noteId } = await seedArrival();
    const second = await openAtelierIntake(sdb, {
      conversationId,
      phoneE164: OWNER,
      triggerWaMessageId: noteId,
      zapiMessageId: "MSG-NOTE",
      kind: "text",
      body: "x",
      now: NOW,
    });
    expect(second).toBeNull();
    expect(await db.select().from(schema.atelierIntakes)).toHaveLength(1);
    const events = await db.select().from(schema.outboxEvents);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("wa.atelier_intake");
    expect(events[0].nextAttemptAt.getTime()).toBe(NOW.getTime() + 45_000);
  });

  it("a chegada reivindica as fotos ao abrir: um recado seguinte não as vê", async () => {
    const { conversationId, photoIds } = await seedArrival();
    const secondNoteId = await seedInbound(conversationId, {
      kind: "text",
      body: "esqueci: custou 120",
      at: new Date(NOW.getTime() + 20_000),
      zapiId: "MSG-NOTE-2",
    });
    await openAtelierIntake(sdb, {
      conversationId,
      phoneE164: OWNER,
      triggerWaMessageId: secondNoteId,
      zapiMessageId: "MSG-NOTE-2",
      kind: "text",
      body: "esqueci: custou 120",
      now: new Date(NOW.getTime() + 20_000),
    });
    const rows = await db.select().from(schema.atelierIntakes).orderBy(schema.atelierIntakes.createdAt);
    expect(rows[0].photoWaMessageIds).toEqual(photoIds);
    expect(rows[1].photoWaMessageIds).toEqual([]);
  });

  it("foto que chega logo depois do recado (webhook atrasado) entra na mesma chegada", async () => {
    const { conversationId, noteId } = await seedArrival();
    provider.setMediaFixture("https://cdn.z-api/foto-late.jpg", await jpeg("#a0b0c0"), "image/jpeg");
    const lateId = await seedInbound(conversationId, {
      kind: "image",
      body: INBOUND_MEDIA_MARKERS.image,
      mediaUrl: "https://cdn.z-api/foto-late.jpg",
      at: new Date(NOW.getTime() + 20_000),
      zapiId: "MSG-FOTO-LATE",
    });
    const result = await processAtelierIntake(sdb, provider, storage, assistant, { conversationId, triggerWaMessageId: noteId }, clock);
    expect(result).toMatchObject({ created: true, photos: 3 });
    const [intake] = await db.select().from(schema.atelierIntakes);
    expect(intake.photoWaMessageIds).toHaveLength(3);
    expect(intake.photoWaMessageIds[2]).toBe(lateId);
  });

  it("foto 3 minutos depois do recado já é de outra chegada: não entra", async () => {
    const { conversationId, noteId } = await seedArrival();
    await seedInbound(conversationId, {
      kind: "image",
      body: INBOUND_MEDIA_MARKERS.image,
      mediaUrl: "https://cdn.z-api/foto-1.jpg",
      at: new Date(NOW.getTime() + 180_000),
      zapiId: "MSG-FOTO-DEPOIS",
    });
    const result = await processAtelierIntake(sdb, provider, storage, assistant, { conversationId, triggerWaMessageId: noteId }, {
      now: () => new Date(NOW.getTime() + 200_000),
    });
    expect(result).toMatchObject({ created: true, photos: 2 });
  });

  it("retomada depois de falha no meio: sobe só a foto que faltou e reenvia o aviso", async () => {
    const { conversationId, photoIds, noteId } = await seedArrival();
    const first = await processAtelierIntake(sdb, provider, storage, assistant, { conversationId, triggerWaMessageId: noteId }, clock);
    if (!("created" in first)) throw new Error("esperava created");
    // Como se a 1.ª tentativa tivesse caído depois da primeira foto.
    await db
      .update(schema.atelierIntakes)
      .set({ status: "failed", uploadedWaMessageIds: [photoIds[0]], errorDetail: "queda" })
      .where(eq(schema.atelierIntakes.triggerWaMessageId, noteId));
    provider.sentMessages.length = 0;
    const again = await processAtelierIntake(sdb, provider, storage, assistant, { conversationId, triggerWaMessageId: noteId, attempt: 1 }, clock);
    expect(again).toMatchObject({ created: true, productId: first.productId, photos: 2, failedPhotos: 0 });
    // 2 da primeira passada + 1 reenviada (a que "faltava"); nenhum produto novo.
    const images = await db.select().from(schema.productImages).where(eq(schema.productImages.productId, first.productId));
    expect(images).toHaveLength(3);
    expect(await db.select().from(schema.products)).toHaveLength(1);
    // O aviso tem dedupe por chegada: não sai duas vezes; a inteligência não é chamada de novo.
    expect(provider.sentMessages).toHaveLength(0);
    expect(assistant.extractions).toHaveLength(1);
  });

  it("provedor fora na hora do aviso: a chegada fica por fechar e a retomada só reenvia (1 produto, 1 audit)", async () => {
    const { conversationId, noteId } = await seedArrival();
    provider.simulateDisconnect();
    await expect(
      processAtelierIntake(sdb, provider, storage, assistant, { conversationId, triggerWaMessageId: noteId }, clock),
    ).rejects.toThrow();
    let [intake] = await db.select().from(schema.atelierIntakes);
    expect(intake.status).toBe("failed");
    expect(intake.productId).not.toBeNull();
    expect(intake.uploadedWaMessageIds).toHaveLength(2);
    expect(await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "atelier.intake"))).toHaveLength(0);

    provider.simulateReconnect();
    const again = await processAtelierIntake(sdb, provider, storage, assistant, { conversationId, triggerWaMessageId: noteId, attempt: 1 }, clock);
    expect(again).toMatchObject({ created: true, photos: 2, failedPhotos: 0 });
    [intake] = await db.select().from(schema.atelierIntakes);
    expect(intake.status).toBe("done");
    expect(await db.select().from(schema.products)).toHaveLength(1);
    expect(await db.select().from(schema.productImages)).toHaveLength(2);
    expect(await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "atelier.intake"))).toHaveLength(1);
    expect(provider.sentMessages).toHaveLength(1);
    expect(provider.sentMessages[0].body).toContain("Rascunho pronto");
  });

  it("WhatsApp desligado: o rascunho nasce, a chegada fecha e fica anotado que o aviso não saiu", async () => {
    await db.update(schema.settings).set({ value: false }).where(eq(schema.settings.key, "wa_enabled"));
    const { conversationId, noteId } = await seedArrival();
    const result = await processAtelierIntake(sdb, provider, storage, assistant, { conversationId, triggerWaMessageId: noteId }, clock);
    expect(result).toMatchObject({ created: true, photos: 2 });
    const [intake] = await db.select().from(schema.atelierIntakes);
    expect(intake.status).toBe("done");
    expect(intake.errorDetail).toBe("aviso não enviado: desabilitado");
    expect(provider.sentMessages).toHaveLength(0);
  });

  const ARRIVAL_JSON = {
    name: "Longo Dunas",
    categorySlug: "vestidos",
    description:
      "Vestido longo de linho com caimento fluido e alças finas, pensado para as tardes de calor: o tecido respira, seca rápido e acompanha o corpo sem marcar. O decote reto e a saia evasê alongam a silhueta; o comprimento midi-longo fica elegante de dia e à noite. Em Belém, é a peça que vai do almoço em família ao fim de tarde na orla sem perder o frescor.",
    composition: "100% linho",
    careSymbols: ["hand_wash"],
    careFreeText: "Secar à sombra",
    fitNotes: "Corte fluido, comprimento midi-longo.",
    colors: ["Areia", "Terra"],
    sizes: ["P", "M", "G", "GG"],
    sizeRange: { from: "P", to: "GG" },
    quantityPerVariant: 3,
    totalQuantity: null,
    costCents: 12000,
    costBasis: "per_piece",
    supplierName: "Aurora",
    weightGramsEstimate: 320,
    warnings: ["Etiqueta de composição não aparece nas fotos"],
  };

  it("recado interpretado: grade cor × tamanho com custo, sala, ficha, preço sugerido e a mensagem com os detalhes", async () => {
    await createTestFeeRuleAndPolicy(db);
    await db.insert(schema.categories).values({ name: "Vestidos", slug: "vestidos" });
    assistant.enqueueExtraction(ARRIVAL_JSON);
    const { conversationId, noteId } = await seedArrival("chegou o Longo Dunas da Aurora, areia e terra, do P ao GG, três de cada, custou 120");
    const result = await processAtelierIntake(sdb, provider, storage, assistant, { conversationId, triggerWaMessageId: noteId }, clock);
    expect(result).toMatchObject({ created: true, name: "Longo Dunas", photos: 2, interpreted: true });
    if (!("created" in result)) throw new Error("esperava created");

    // A inteligência recebeu o recado, as duas fotos reduzidas e o schema da chegada.
    expect(assistant.extractions).toHaveLength(1);
    expect(assistant.extractions[0].images).toHaveLength(2);
    expect(assistant.extractions[0].userText).toContain("chegou o Longo Dunas da Aurora");
    expect(assistant.extractions[0].system).toContain("Vestidos (slug: vestidos)");

    const [product] = await db.select().from(schema.products).where(eq(schema.products.id, result.productId));
    expect(product).toMatchObject({ name: "Longo Dunas", status: "draft", composition: "100% linho", careNotes: "hand_wash\ndry_shade", attributesSchema: ["cor", "tamanho"] });
    expect(product.description).toContain("Vestido longo de linho");
    const [category] = await db.select().from(schema.categories);
    expect(product.categoryId).toBe(category.id);

    const variants = await db.select().from(schema.productVariants).where(eq(schema.productVariants.productId, product.id));
    expect(variants).toHaveLength(8);
    expect(variants.map((variant) => variant.sku).sort()).toEqual(
      ["LONGO-DUNAS-AREI-P", "LONGO-DUNAS-AREI-M", "LONGO-DUNAS-AREI-G", "LONGO-DUNAS-AREI-GG", "LONGO-DUNAS-TERR-P", "LONGO-DUNAS-TERR-M", "LONGO-DUNAS-TERR-G", "LONGO-DUNAS-TERR-GG"].sort(),
    );
    expect(variants.every((variant) => variant.costCents === 12000 && variant.weightGrams === 320)).toBe(true);
    // Estoque só no próximo passo: nada em mãos ainda.
    const levels = await db.select().from(schema.stockLevels);
    expect(levels.every((level) => level.onHand === 0)).toBe(true);
    expect(await db.select().from(schema.stockMovements)).toHaveLength(0);

    const [intake] = await db.select().from(schema.atelierIntakes);
    expect(intake.status).toBe("done");
    const parsed = intake.parsed as { proposal: { colors: string[]; totalQuantity: number; unitCostCents: number; supplierName: string; warnings: string[] }; suggestedPriceCents: number | null; usage: unknown; failed: string | null; estimatedCostUsdCents: number };
    expect(parsed.proposal).toMatchObject({ colors: ["Areia", "Terra"], totalQuantity: 24, unitCostCents: 12000, supplierName: "Aurora" });
    expect(parsed.failed).toBeNull();
    expect(parsed.suggestedPriceCents).toBeGreaterThan(12000);
    expect(parsed.estimatedCostUsdCents).toBeGreaterThan(0);

    expect(provider.sentMessages[0].body).toContain(`Rascunho pronto · Longo Dunas · 2 fotos · 2 cores × 4 tamanhos · 3 de cada (24 peças) · custo ${formatCentsBRL(12000)} · sugerido ${formatCentsBRL(parsed.suggestedPriceCents as number)}`);
    expect(provider.sentMessages[0].body).toContain("· Aurora");
    expect(provider.sentMessages[0].body).not.toContain("sem a grade");

    const [audit] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "atelier.intake"));
    expect(audit.after).toMatchObject({ interpreted: true, variants: 8, model: "claude-sonnet-5" });
    expect((audit.after as { usage: { inputTokens: number } }).usage.inputTokens).toBeGreaterThan(0);

    expect(await getAtelierIntakeForProduct(sdb, product.id)).toMatchObject({ parsed: { suggestedPriceCents: parsed.suggestedPriceCents } });
  });

  it("faixa dita sem lista ('do 36 ao 40') e custo total: a grade sai numérica e o custo vira por peça", async () => {
    assistant.enqueueExtraction({ ...ARRIVAL_JSON, colors: ["Preto"], sizes: [], sizeRange: { from: "36", to: "40" }, quantityPerVariant: 2, costCents: 60000, costBasis: "total", categorySlug: null, supplierName: null });
    const { conversationId, noteId } = await seedArrival("calça alfaiataria preta do 36 ao 40, duas de cada, 600 o lote");
    const result = await processAtelierIntake(sdb, provider, storage, assistant, { conversationId, triggerWaMessageId: noteId }, clock);
    if (!("created" in result)) throw new Error("esperava created");
    const variants = await db.select().from(schema.productVariants).where(eq(schema.productVariants.productId, result.productId));
    expect(variants.map((variant) => variant.attributes)).toEqual([
      { cor: "Preto", tamanho: "36" },
      { cor: "Preto", tamanho: "38" },
      { cor: "Preto", tamanho: "40" },
    ]);
    // 600 o lote / 6 peças = R$ 100 por peça.
    expect(variants.every((variant) => variant.costCents === 10000)).toBe(true);
    expect(provider.sentMessages[0].body).toContain(`1 cor × 3 tamanhos · 2 de cada (6 peças) · custo ${formatCentsBRL(10000)}`);
  });

  it("inteligência indisponível: a ficha nasce simples pelo recado e a mensagem avisa", async () => {
    assistant.enqueueExtraction(new AssistantUnavailableError("sem chave da Anthropic"));
    const { conversationId, noteId } = await seedArrival();
    const result = await processAtelierIntake(sdb, provider, storage, assistant, { conversationId, triggerWaMessageId: noteId }, clock);
    expect(result).toMatchObject({ created: true, name: "Longo Dunas", interpreted: false });
    if (!("created" in result)) throw new Error("esperava created");
    const variants = await db.select().from(schema.productVariants).where(eq(schema.productVariants.productId, result.productId));
    expect(variants.map((variant) => variant.sku)).toEqual(["LONGO-DUNAS"]);
    const [intake] = await db.select().from(schema.atelierIntakes);
    expect((intake.parsed as { failed: string }).failed).toBe("ia_indisponivel");
    expect(intake.status).toBe("done");
    expect(provider.sentMessages[0].body).toContain("Rascunho pronto · Longo Dunas · 2 fotos · sem a grade (a inteligência não respondeu)");
  });

  it("sem tempo para a inteligência (prazo do worker curto): nem chama, ficha simples com aviso", async () => {
    const { conversationId, noteId } = await seedArrival();
    const result = await processAtelierIntake(
      sdb,
      provider,
      storage,
      assistant,
      { conversationId, triggerWaMessageId: noteId, deadlineAt: new Date(clock.now().getTime() + 15_000) },
      clock,
    );
    expect(result).toMatchObject({ created: true, name: "Longo Dunas", interpreted: false });
    expect(assistant.extractions).toHaveLength(0);
    const [intake] = await db.select().from(schema.atelierIntakes);
    expect((intake.parsed as { failed: string }).failed).toBe("sem_tempo");
    expect(provider.sentMessages[0].body).toContain("sem a grade");
  });

  it("chegada antiga com produto criado e sem leitura gravada: a inteligência não é chamada na retomada", async () => {
    const { conversationId, photoIds, noteId } = await seedArrival();
    const first = await processAtelierIntake(sdb, provider, storage, assistant, { conversationId, triggerWaMessageId: noteId }, clock);
    if (!("created" in first)) throw new Error("esperava created");
    await db
      .update(schema.atelierIntakes)
      .set({ status: "failed", parsed: null, uploadedWaMessageIds: [photoIds[0]] })
      .where(eq(schema.atelierIntakes.triggerWaMessageId, noteId));
    const again = await processAtelierIntake(sdb, provider, storage, assistant, { conversationId, triggerWaMessageId: noteId, attempt: 1 }, clock);
    expect(again).toMatchObject({ created: true, productId: first.productId, interpreted: false });
    expect(assistant.extractions).toHaveLength(1);
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "atelier.intake"));
    expect(audits.at(-1)?.after).toMatchObject({ interpretationFailed: "sem_interpretacao", variants: 1 });
  });

  it("a leitura da inteligência fica gravada antes do produto: retomada não paga de novo", async () => {
    assistant.enqueueExtraction(ARRIVAL_JSON);
    const { conversationId, noteId } = await seedArrival();
    provider.simulateDisconnect();
    await expect(processAtelierIntake(sdb, provider, storage, assistant, { conversationId, triggerWaMessageId: noteId }, clock)).rejects.toThrow();
    const [intake] = await db.select().from(schema.atelierIntakes);
    expect((intake.parsed as { proposal: { colors: string[] } | null }).proposal?.colors).toEqual(["Areia", "Terra"]);
    provider.simulateReconnect();
    const again = await processAtelierIntake(sdb, provider, storage, assistant, { conversationId, triggerWaMessageId: noteId, attempt: 1 }, clock);
    expect(again).toMatchObject({ created: true, interpreted: true });
    expect(assistant.extractions).toHaveLength(1);
    expect(provider.sentMessages[0].body).toContain("2 cores × 4 tamanhos");
  });

  it("SKU da grade que já existe no catálogo ganha sufixo, o resto fica", async () => {
    const [other] = await db.insert(schema.products).values({ name: "Outro", slug: "outro" }).returning();
    await db.insert(schema.productVariants).values({ productId: other.id, sku: "LONGO-DUNAS-AREI-P", attributes: {} });
    assistant.enqueueExtraction({ ...ARRIVAL_JSON, sizes: ["P"], sizeRange: null });
    const { conversationId, noteId } = await seedArrival();
    const result = await processAtelierIntake(sdb, provider, storage, assistant, { conversationId, triggerWaMessageId: noteId }, clock);
    if (!("created" in result)) throw new Error("esperava created");
    const variants = await db.select().from(schema.productVariants).where(eq(schema.productVariants.productId, result.productId));
    expect(variants.map((variant) => variant.sku).sort()).toEqual(["LONGO-DUNAS-AREI-P-2", "LONGO-DUNAS-TERR-P"]);
  });
});
