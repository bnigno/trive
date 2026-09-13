// A montagem da chegada na fila: as fotos da dona viram um rascunho com as
// fotos publicadas e ela recebe "Rascunho pronto · … · N fotos" com o link.
// Reentrega não duplica; foto expirada e recado sem fotos viram orientação.
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeFileStorage } from "@/adapters/storage/fake";
import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import { INBOUND_MEDIA_MARKERS } from "@/core/whatsapp/media";
import * as schema from "@/db/schema";
import { initialWaTemplates } from "@/db/seed-data";
import type { DbOrTx } from "@/queue/enqueue";
import {
  getAtelierIntakeForProduct,
  openAtelierIntake,
  processAtelierIntake,
} from "@/services/atelier";
import { createTestDb, type TestDb } from "../helpers/db";

const OWNER = "+5591981037536";
const NOW = new Date("2026-09-13T18:00:00Z");

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;
let provider: FakeMessagingProvider;
let storage: FakeFileStorage;

async function jpeg(color: string): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 80, channels: 3, background: color } }).jpeg().toBuffer();
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  provider = new FakeMessagingProvider();
  storage = new FakeFileStorage();
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
    const result = await processAtelierIntake(sdb, provider, storage, { conversationId, triggerWaMessageId: noteId }, clock);
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
    await processAtelierIntake(sdb, provider, storage, { conversationId, triggerWaMessageId: noteId }, clock);
    const again = await processAtelierIntake(sdb, provider, storage, { conversationId, triggerWaMessageId: noteId, attempt: 1 }, clock);
    expect(again).toEqual({ skipped: "ja_processado" });
    expect(await db.select().from(schema.products)).toHaveLength(1);
    expect(provider.sentMessages).toHaveLength(1);
  });

  it("SKU já existente ganha sufixo", async () => {
    const [product] = await db.insert(schema.products).values({ name: "Outro", slug: "outro" }).returning();
    await db.insert(schema.productVariants).values({ productId: product.id, sku: "LONGO-DUNAS", attributes: {} });
    const { conversationId, noteId } = await seedArrival();
    const result = await processAtelierIntake(sdb, provider, storage, { conversationId, triggerWaMessageId: noteId }, clock);
    if (!("created" in result)) throw new Error("esperava created");
    const variants = await db.select().from(schema.productVariants).where(eq(schema.productVariants.productId, result.productId));
    expect(variants[0].sku).toBe("LONGO-DUNAS-2");
  });

  it("todas as fotos expiradas na Z-API: nada é criado e a dona recebe a orientação", async () => {
    const { conversationId, noteId } = await seedArrival();
    provider.reset();
    const result = await processAtelierIntake(sdb, provider, storage, { conversationId, triggerWaMessageId: noteId }, clock);
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
    const result = await processAtelierIntake(sdb, provider, storage, { conversationId, triggerWaMessageId: noteId }, clock);
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
      triggerWaMessageId: noteId,
      zapiMessageId: "MSG-SO-TEXTO",
      kind: "text",
      body: "chegou o vestido",
      now: NOW,
    });
    const result = await processAtelierIntake(sdb, provider, storage, { conversationId, triggerWaMessageId: noteId }, clock);
    expect(result).toMatchObject({ failed: "sem_fotos" });
    expect(await db.select().from(schema.products)).toHaveLength(0);
    expect(provider.sentMessages[0].body).toContain("Não achei fotos suas");
  });

  it("Ateliê desligado: a chegada já aberta não é montada", async () => {
    await db.insert(schema.settings).values({ key: "atelier_enabled", value: false });
    const { conversationId, noteId } = await seedArrival();
    const result = await processAtelierIntake(sdb, provider, storage, { conversationId, triggerWaMessageId: noteId }, clock);
    expect(result).toEqual({ skipped: "desligado" });
    expect(provider.sentMessages).toHaveLength(0);
  });

  it("abrir a chegada duas vezes com o mesmo recado (reentrega do webhook) não duplica", async () => {
    const { conversationId, noteId } = await seedArrival();
    const second = await openAtelierIntake(sdb, {
      conversationId,
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
});
