// A Lia manda o áudio da curadora (PGlite + fakes): detalhar_produto aponta
// a ferramenta quando a peça tem áudio e o interruptor está ligado;
// enviar_nota_da_curadora vira anexo de voz que sai ANTES do texto com
// dedupe (o retry não repete), uma vez por peça na conversa; desligado, a
// Lia fica na nota escrita; em copiloto o áudio vai na sugestão, sem marcador.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeSalesAssistant } from "@/adapters/assistant/fake";
import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import type { BotAttachment } from "@/services/bot/shared";
import { approveSuggestion, getPendingSuggestion, sendApprovedSuggestion } from "@/services/wa-suggestions";
import { buildToolExecutor, historyTextForOutbound, runBotTurn } from "@/services/wa-bot";
import { createTestDb, type TestDb } from "../helpers/db";

const PHONE = "+5511999990000";
const INBOUND = "00000000-0000-4000-8000-0000000000aa";
const OWNER = "00000000-0000-4000-8000-00000000d0a0";
const AUDIO_PATH = "products/dunas/curator-note.webm";
const AUDIO_URL = `https://x.supabase.co/storage/v1/object/public/product-images/${AUDIO_PATH}`;

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;
let assistant: FakeSalesAssistant;
let provider: FakeMessagingProvider;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  assistant = new FakeSalesAssistant();
  provider = new FakeMessagingProvider();
  vi.stubEnv("ADAPTER_MODE", "fake");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://x.supabase.co");
  await db.insert(schema.settings).values([
    { key: "wa_enabled", value: true },
    { key: "bot_enabled", value: true },
    { key: "bot_seller_name", value: "Lia" },
    { key: "owner_whatsapp_phone", value: "+5591981037536" },
  ]);
  await db.insert(schema.users).values({ id: OWNER, email: "dona@trive.test", role: "owner", fullName: "Dona" });
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
});

async function seedProducts(): Promise<string> {
  const rows = [
    { name: "Longo Dunas", slug: "longo-dunas", sku: "LD-M", curatorNote: "Linho puro, respira no calor.", curatorAudioPath: AUDIO_PATH, curatorAudioMime: "audio/webm" },
    { name: "Camisa Brisa", slug: "camisa-brisa", sku: "CB-M", curatorNote: "Algodão leve.", curatorAudioPath: null, curatorAudioMime: null },
  ];
  for (const row of rows) {
    const [product] = await db
      .insert(schema.products)
      .values({ name: row.name, slug: row.slug, status: "active", attributesSchema: ["cor", "tamanho"], curatorNote: row.curatorNote, curatorAudioPath: row.curatorAudioPath, curatorAudioMime: row.curatorAudioMime })
      .returning({ id: schema.products.id });
    const [variant] = await db.insert(schema.productVariants).values({ productId: product.id, sku: row.sku, attributes: { cor: "Areia", tamanho: "M" }, costCents: 100 }).returning({ id: schema.productVariants.id });
    await db.insert(schema.stockLevels).values({ productVariantId: variant.id, onHand: 3, reserved: 0 });
    await db.insert(schema.priceVersions).values({ productVariantId: variant.id, versionNumber: 1, status: "active", priceCents: 28900, origin: "initial", breakdown: {}, costSnapshotCents: 100, computedMarginRate: "0.3000", activatedAt: new Date() });
  }
  const [conversation] = await db.insert(schema.waConversations).values({ phoneE164: PHONE, status: "open" }).returning({ id: schema.waConversations.id });
  return conversation.id;
}

let sequence = 0;
async function addInbound(conversationId: string, body: string): Promise<string> {
  sequence += 1;
  const at = new Date(Date.now() - 60_000 + sequence * 1000);
  const [message] = await db
    .insert(schema.waMessages)
    .values({ conversationId, direction: "inbound", zapiMessageId: `MSG-${sequence}-${Math.random().toString(36).slice(2, 8)}`, body, status: "delivered", deliveredAt: at, createdAt: at })
    .returning({ id: schema.waMessages.id });
  return message.id;
}

describe("enviar_nota_da_curadora (executor)", () => {
  it("detalhar_produto aponta a ferramenta; o áudio vira anexo uma vez por peça, reenviar repete, peça sem áudio recusa", async () => {
    const conversationId = await seedProducts();
    const attachments: BotAttachment[] = [];
    const executor = buildToolExecutor(sdb, { conversationId, phoneE164: PHONE, customerId: null, lastInboundId: INBOUND, onAttachment: (attachment) => attachments.push(attachment) });

    const detail = await executor("detalhar_produto", { produto: "longo-dunas" });
    expect(detail.text).toContain("«Linho puro, respira no calor.»");
    expect(detail.text).toContain("chame enviar_nota_da_curadora");
    expect(detail.text).not.toContain("/produto/longo-dunas");
    attachments.length = 0;

    const sent = await executor("enviar_nota_da_curadora", { produto: "Longo Dunas" });
    expect(sent.ok).toBe(true);
    expect(sent.text).toContain("[Áudio enviado");
    expect(sent.text).toContain("não transcreva nem resuma");
    expect(attachments).toEqual([{ kind: "audio", audioUrl: AUDIO_URL, body: "🎤 Nota da curadora sobre Longo Dunas" }]);
    const [conversation] = await db.select().from(schema.waConversations).where(eq(schema.waConversations.id, conversationId));
    expect((conversation.botState as { curatorNotesSent?: string[] }).curatorNotesSent).toEqual(["longo-dunas"]);

    // Segunda vez na mesma conversa: nada sai, a Lia aponta a mensagem acima.
    const again = await executor("enviar_nota_da_curadora", { produto: "longo-dunas" });
    expect(again.ok).toBe(true);
    expect(again.text).toContain("já foi enviado");
    expect(attachments).toHaveLength(1);
    // Ela pediu de novo.
    const resend = await executor("enviar_nota_da_curadora", { produto: "longo-dunas", reenviar: true });
    expect(resend.ok).toBe(true);
    expect(attachments).toHaveLength(2);

    const noAudio = await executor("enviar_nota_da_curadora", { produto: "camisa-brisa" });
    expect(noAudio.ok).toBe(false);
    expect(noAudio.text).toContain("não tem nota em áudio");
    expect(noAudio.text).toContain("nota escrita");
    expect((await executor("enviar_nota_da_curadora", { produto: "nao-existe" })).ok).toBe(false);
    expect(attachments).toHaveLength(2);
  });

  it("interruptor desligado: detalhar_produto volta ao link da página e a ferramenta recusa sem anexo", async () => {
    const conversationId = await seedProducts();
    await db.insert(schema.settings).values({ key: "bot_audio_notes_enabled", value: false });
    const attachments: BotAttachment[] = [];
    const executor = buildToolExecutor(sdb, { conversationId, phoneE164: PHONE, customerId: null, lastInboundId: INBOUND, onAttachment: (attachment) => attachments.push(attachment) });
    const detail = await executor("detalhar_produto", { produto: "longo-dunas" });
    expect(detail.text).not.toContain("enviar_nota_da_curadora");
    expect(detail.text).toContain("A nota também está em áudio, na voz da curadora, na página da peça");
    attachments.length = 0;
    const blocked = await executor("enviar_nota_da_curadora", { produto: "longo-dunas" });
    expect(blocked.ok).toBe(false);
    expect(blocked.text).toContain("desligado");
    expect(blocked.text).toContain("Não prometa o áudio");
    expect(attachments).toHaveLength(0);
  });

  it("no ensaio (dryRun) o anexo aparece mas nada fica no caderninho; em copiloto o anexo sai sem marcador", async () => {
    const conversationId = await seedProducts();
    const attachments: BotAttachment[] = [];
    const dry = buildToolExecutor(sdb, { conversationId, phoneE164: PHONE, customerId: null, lastInboundId: INBOUND, dryRun: true, onAttachment: (attachment) => attachments.push(attachment) });
    expect((await dry("enviar_nota_da_curadora", { produto: "longo-dunas" })).ok).toBe(true);
    expect(attachments).toHaveLength(1);
    let [conversation] = await db.select().from(schema.waConversations).where(eq(schema.waConversations.id, conversationId));
    expect(conversation.botState).toBeNull();

    const copilot = buildToolExecutor(sdb, { conversationId, phoneE164: PHONE, customerId: null, lastInboundId: INBOUND, copilot: true, onAttachment: (attachment) => attachments.push(attachment) });
    expect((await copilot("enviar_nota_da_curadora", { produto: "longo-dunas" })).ok).toBe(true);
    expect(attachments).toHaveLength(2);
    [conversation] = await db.select().from(schema.waConversations).where(eq(schema.waConversations.id, conversationId));
    expect(conversation.botState).toBeNull();
    // Sem marcador, a dona pode aprovar outro envio depois de descartar o primeiro.
    expect((await copilot("enviar_nota_da_curadora", { produto: "longo-dunas" })).text).toContain("[Áudio enviado");
  });
});

describe("turno da Lia com áudio", () => {
  it("a voz sai como mensagem de voz ANTES do texto, fica na conversa como áudio e o retry não repete", async () => {
    const conversationId = await seedProducts();
    await addInbound(conversationId, "esse linho esquenta?");
    assistant.enqueueScript({
      toolCalls: [{ name: "enviar_nota_da_curadora", input: { produto: "longo-dunas" } }],
      replyTemplate: "A curadora gravou uma nota sobre ele — ouve aqui 🤎",
    });
    const result = await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(result).toMatchObject({ replied: true });
    expect(provider.sentAudios).toHaveLength(1);
    expect(provider.sentAudios[0]).toMatchObject({ toE164: PHONE, audioUrl: AUDIO_URL });
    expect(provider.sentMessages).toHaveLength(1);
    // O áudio saiu antes do texto (contador compartilhado do fake).
    expect(provider.sentAudios[0].providerMessageId < provider.sentMessages[0].providerMessageId).toBe(true);

    const outbound = (await db.select().from(schema.waMessages).where(eq(schema.waMessages.conversationId, conversationId))).filter((row) => row.direction === "outbound");
    const audio = outbound.find((row) => row.kind === "audio");
    expect(audio).toMatchObject({ body: "🎤 Nota da curadora sobre Longo Dunas", mediaUrl: AUDIO_URL, status: "sent" });
    expect(audio?.dedupeKey).toMatch(/^wa\.bot_media:/);
    expect(historyTextForOutbound({ kind: "audio", body: audio!.body, dedupeKey: audio!.dedupeKey, templateKey: null })).toBe(
      "[mensagem de voz enviada à cliente] 🎤 Nota da curadora sobre Longo Dunas",
    );

    // Retry do evento (mesma inbound): o turno inteiro é idempotente.
    assistant.enqueueScript({
      toolCalls: [{ name: "enviar_nota_da_curadora", input: { produto: "longo-dunas", reenviar: true } }],
      replyTemplate: "de novo",
    });
    await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(provider.sentAudios).toHaveLength(1);
    expect(provider.sentMessages).toHaveLength(1);
  });

  it("provedor recusa o áudio: o texto da Lia segue mesmo assim (melhor esforço)", async () => {
    const conversationId = await seedProducts();
    await addInbound(conversationId, "esse linho esquenta?");
    const original = provider.sendAudio.bind(provider);
    provider.sendAudio = async () => {
      throw new Error("Z-API: formato não aceito");
    };
    assistant.enqueueScript({
      toolCalls: [{ name: "enviar_nota_da_curadora", input: { produto: "longo-dunas" } }],
      replyTemplate: "A curadora gravou uma nota sobre ele 🤎",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await runBotTurn(sdb, assistant, provider, { conversationId });
    warn.mockRestore();
    provider.sendAudio = original;
    expect(result).toMatchObject({ replied: true });
    expect(provider.sentMessages).toHaveLength(1);
    const outbound = (await db.select().from(schema.waMessages).where(eq(schema.waMessages.conversationId, conversationId))).filter((row) => row.direction === "outbound");
    expect(outbound.find((row) => row.kind === "audio")?.status).toBe("failed");
  });

  it("em copiloto o áudio vai na sugestão e sai quando a dona aprova", async () => {
    const conversationId = await seedProducts();
    await db.insert(schema.settings).values({ key: "bot_mode", value: "copilot" });
    await addInbound(conversationId, "esse linho esquenta?");
    assistant.enqueueScript({
      toolCalls: [{ name: "enviar_nota_da_curadora", input: { produto: "longo-dunas" } }],
      replyTemplate: "A curadora gravou uma nota sobre ele — ouve aqui 🤎",
    });
    const result = await runBotTurn(sdb, assistant, provider, { conversationId });
    expect(result).toMatchObject({ suggested: true });
    expect(provider.sentAudios).toHaveLength(0);
    const pending = await getPendingSuggestion(sdb, conversationId);
    expect(pending!.attachments).toEqual([{ kind: "audio", audioUrl: AUDIO_URL, body: "🎤 Nota da curadora sobre Longo Dunas" }]);
    expect(pending!.toolCalls).toEqual([{ name: "enviar_nota_da_curadora", ok: true }]);

    expect(await approveSuggestion(sdb, { suggestionId: pending!.id, userId: OWNER })).toEqual({ queued: true });
    expect(await sendApprovedSuggestion(sdb, provider, { suggestionId: pending!.id })).toEqual({ sent: true, replied: true });
    expect(provider.sentAudios).toHaveLength(1);
    expect(provider.sentAudios[0]).toMatchObject({ toE164: PHONE, audioUrl: AUDIO_URL });
    expect(provider.sentMessages).toHaveLength(1);
    // Retry do evento: nem áudio nem texto de novo.
    expect(await sendApprovedSuggestion(sdb, provider, { suggestionId: pending!.id })).toEqual({ sent: true, replied: false });
    expect(provider.sentAudios).toHaveLength(1);
  });
});
