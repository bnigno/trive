// A Lia e o Provador (PGlite + fakes): a menção vira um turno só de catálogo
// respondido no grupo (citando, com @número, teto por hora, uma resposta por
// menção); os sinais entram no caderninho; "só privado" e SAIR tiram da sala
// pela fila; os avisos no privado (afinidade, última unidade, vencedora da
// enquete) saem com opt-in, na janela, de 5 em 5 min, e nunca duas vezes.
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeSalesAssistant } from "@/adapters/assistant/fake";
import type { GroupMetadata } from "@/adapters/zapi";
import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { loadMemoryLines } from "@/services/bot/style";
import { adjustStock } from "@/services/stock";
import {
  fanOutAffinityNotices,
  fanOutLastUnitNotices,
  fanOutPollWinnerNotices,
  GROUP_NOTICE_INTERVAL_SECONDS,
  maybeEnqueueMentionTurn,
  removeFromGroups,
  runGroupMentionTurn,
  sendAffinityNotice,
  sendLastUnitNotice,
  sendPollWinnerNotice,
} from "@/services/wa-group-lia";
import { closeGroupPoll, groupMemoryLines, processGroupInbound, registerGroup, scheduleGroupPost, sendGroupPost, syncGroupMembers } from "@/services/wa-groups";
import { processZapiInbound } from "@/services/wa-inbound";
import { createTestDb, createTestVariant, FIXED_USER_ID, type TestDb } from "../helpers/db";

const kicks: unknown[] = [];
vi.mock("@/inngest/client", () => ({ inngest: { send: async (event: unknown) => { kicks.push(event); return { ids: [] }; } } }));

const GROUP = "120363019502650977-group";
const ANA = "+5591999990001";
const BIA = "+5591999990002";
const NOW = new Date("2026-09-22T13:00:00Z"); // terça 10:00 SP
const sp = (day: string, hour: number, minute = 0) => new Date(`${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00-03:00`);

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;
let provider: FakeMessagingProvider;
let assistant: FakeSalesAssistant;

const metadata = (participants: GroupMetadata["participants"]): GroupMetadata => ({
  groupId: GROUP,
  name: "Provador TRIVÉ",
  description: null,
  ownerE164: "+5591981037536",
  invitationLink: "https://chat.whatsapp.com/fake",
  adminOnlyMessage: false,
  adminOnlySettings: true,
  requireAdminApproval: false,
  participants,
});

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  provider = new FakeMessagingProvider();
  assistant = new FakeSalesAssistant();
  kicks.length = 0;
  vi.stubEnv("ADAPTER_MODE", "fake");
  process.env.ZAPI_WEBHOOK_SECRET = "segredo";
  await db.insert(schema.settings).values([
    { key: "wa_enabled", value: true },
    { key: "bot_enabled", value: true },
    { key: "groups_enabled", value: true },
    { key: "bot_group_mentions_enabled", value: true },
    { key: "bot_seller_name", value: "Lia" },
    { key: "store_whatsapp", value: "(91) 98103-7536" },
  ]);
  await db.insert(schema.waTemplates).values([
    { key: "provador_affinity", label: "afinidade", bodyTemplate: "{{nome}}: {{peca}} {{motivo}} — {{tamanho}} por {{horas}} h?", variables: ["nome", "peca", "motivo", "tamanho", "horas"], isActive: true },
    { key: "provador_last_unit", label: "última", bodyTemplate: "{{nome}}, ficou uma {{peca}} em {{tamanho}}.", variables: ["nome", "peca", "tamanho"], isActive: true },
    { key: "provador_poll_winner", label: "vencedora", bodyTemplate: "Deu {{opcao}}: {{peca}} chegou ({{quantidade}}), {{horas}} h de reserva.", variables: ["opcao", "peca", "quantidade", "horas"], isActive: true },
  ]);
  provider.setGroup(
    metadata([
      { phoneE164: "+5591981037536", lid: null, isAdmin: true },
      { phoneE164: ANA, lid: null, isAdmin: false },
      { phoneE164: BIA, lid: null, isAdmin: false },
    ]),
  );
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
  delete process.env.ZAPI_WEBHOOK_SECRET;
});

async function customer(name: string, phone: string, opts: { optIn?: boolean; sizes?: { vestido?: string; blusa?: string; calca?: string }; colorsLove?: string[] } = {}) {
  const [row] = await db
    .insert(schema.customers)
    .values({ fullName: name, phoneE164: phone, marketingOptIn: opts.optIn ?? true })
    .returning({ id: schema.customers.id });
  if (opts.sizes || opts.colorsLove) {
    await db.insert(schema.customerProfiles).values({
      phoneE164: phone,
      customerId: row.id,
      profile: { sizes: opts.sizes ?? {}, colorsLove: opts.colorsLove ?? [], colorsAvoid: [], fit: "tanto_faz", occasions: [], buysFor: "mim" },
      source: "quiz",
      consentAt: NOW,
    });
  }
  return row.id;
}

async function pricedProduct(name: string, categoryName: string, variants: { size: string; color: string; onHand: number }[]) {
  const [category] = await db
    .insert(schema.categories)
    .values({ name: categoryName, slug: categoryName.toLowerCase().replace(/\s+/g, "-") })
    .onConflictDoNothing()
    .returning({ id: schema.categories.id });
  const categoryId = category?.id ?? (await db.select({ id: schema.categories.id }).from(schema.categories).where(eq(schema.categories.name, categoryName)))[0]!.id;
  let productId = "";
  const variantIds: string[] = [];
  for (const [index, entry] of variants.entries()) {
    const sku = `${name.toUpperCase().replace(/\s+/g, "-")}-${entry.color}-${entry.size}`.toUpperCase();
    let variantId: string;
    if (index === 0) {
      const created = await createTestVariant(db, { sku, onHand: entry.onHand, name });
      productId = created.productId;
      variantId = created.variantId;
      await db.update(schema.products).set({ categoryId }).where(eq(schema.products.id, productId));
    } else {
      const [variant] = await db.insert(schema.productVariants).values({ productId, sku, costCents: 1000 }).returning({ id: schema.productVariants.id });
      variantId = variant.id;
      await db.insert(schema.stockLevels).values({ productVariantId: variantId, onHand: entry.onHand, reserved: 0 });
    }
    await db.update(schema.productVariants).set({ attributes: { tamanho: entry.size, cor: entry.color } }).where(eq(schema.productVariants.id, variantId));
    await db.insert(schema.priceVersions).values({ productVariantId: variantId, versionNumber: 1, status: "active", priceCents: 28900, origin: "initial", breakdown: {}, costSnapshotCents: 1000, computedMarginRate: "0.3000", activatedAt: NOW });
    variantIds.push(variantId);
  }
  return { productId, variantIds };
}

async function registered() {
  const group = await registerGroup(sdb, provider, { providerGroupId: GROUP, userId: FIXED_USER_ID });
  await syncGroupMembers(sdb, provider, { groupId: group.id, now: NOW });
  return group;
}

async function outbox(eventType: string) {
  return db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.eventType, eventType));
}

describe("a Lia chamada no grupo", () => {
  it("menção enfileira UM turno (dedupe por sinal), respeita o teto por hora e o interruptor", async () => {
    const group = await registered();
    const mention = (id: string) => processGroupInbound(sdb, { messageId: id, phone: GROUP, participantPhone: "5591999990001", text: `@Lia tem em M? (${id})` }, { now: NOW, onMention: maybeEnqueueMentionTurn });
    expect(await mention("M-1")).toMatchObject({ recorded: true, kind: "mention", mention: "queued" });
    expect(await mention("M-1")).toMatchObject({ recorded: true, mention: "duplicado" });
    for (const id of ["M-2", "M-3", "M-4", "M-5"]) expect(await mention(id)).toMatchObject({ mention: "queued" });
    expect(await mention("M-6")).toMatchObject({ mention: "teto_hora" });
    expect(await outbox("wa.group_mention")).toHaveLength(5);
    await db.update(schema.settings).set({ value: false }).where(eq(schema.settings.key, "bot_group_mentions_enabled"));
    expect(await mention("M-7")).toMatchObject({ recorded: true, mention: "desligado" });
    expect(group.id).toBeTruthy();
  });

  it("o turno: prompt público só com catálogo, resposta em 2 linhas citando a mensagem com @número; segundo turno pula; sem resposta não manda", async () => {
    await pricedProduct("Vestido Terracota", "Vestidos", [{ size: "M", color: "terracota", onHand: 2 }]);
    const anaId = await customer("Ana Souza", ANA);
    await registered();
    const recorded = await processGroupInbound(sdb, { messageId: "M-1", phone: GROUP, participantPhone: "5591999990001", text: "@Lia o Terracota tem em M?" }, { now: NOW, onMention: maybeEnqueueMentionTurn });
    const signalId = (recorded as { signalId: string }).signalId;

    assistant.enqueueScript({
      toolCalls: [{ name: "listar_produtos", input: { busca: "Terracota" } }],
      replyTemplate: (texts) => `Tem sim: ${texts[0]?.includes("Vestido Terracota") ? "o Terracota está no catálogo" : "não achei"}.\n---\nTe mando os detalhes no privado?\nTerceira linha que não sai.`,
    });
    const result = await runGroupMentionTurn(sdb, assistant, provider, { signalId, now: NOW });
    expect(result).toMatchObject({ replied: true, reply: "Tem sim: o Terracota está no catálogo.\nTe mando os detalhes no privado?" });
    const input = assistant.inputs[0]!;
    expect(input.tools).toEqual(["listar_produtos", "detalhar_produto"]);
    expect(input.system).toContain('no grupo "Provador TRIVÉ"');
    expect(input.system).not.toContain("REGRAS DURAS");
    expect(input.history).toEqual([{ role: "user", text: '[No grupo "Provador TRIVÉ", Ana chamou você:] @Lia o Terracota tem em M?' }]);
    expect(provider.sentMessages).toEqual([
      {
        providerMessageId: expect.any(String),
        toE164: GROUP,
        body: "@5591999990001 Tem sim: o Terracota está no catálogo.\nTe mando os detalhes no privado?",
        typingSeconds: expect.any(Number),
        quotedProviderMessageId: "M-1",
        mentionedPhones: ["5591999990001"],
      },
    ]);
    // Nenhuma lista/foto saiu no grupo e nada foi gravado na conversa (não existe conversa).
    expect(provider.sentOptionLists).toHaveLength(0);
    expect(await db.select().from(schema.waConversations)).toHaveLength(0);
    expect(anaId).toBeTruthy();

    expect(await runGroupMentionTurn(sdb, assistant, provider, { signalId, now: NOW })).toEqual({ skipped: "ja_respondida" });
    expect(provider.sentMessages).toHaveLength(1);

    const second = await processGroupInbound(sdb, { messageId: "M-2", phone: GROUP, participantLid: "220839349862480@lid", text: "@Lia e em G?" }, { now: NOW });
    assistant.enqueueScript({ replyTemplate: "" });
    expect(await runGroupMentionTurn(sdb, assistant, provider, { signalId: (second as { signalId: string }).signalId, now: NOW })).toEqual({ skipped: "sem_resposta" });
    assistant.enqueueScript({ replyTemplate: "Em G também." });
    const lid = await runGroupMentionTurn(sdb, assistant, provider, { signalId: (second as { signalId: string }).signalId, now: NOW });
    expect(lid).toMatchObject({ replied: true });
    // Número oculto: só a citação, sem @número.
    expect(provider.sentMessages.at(-1)).toMatchObject({ body: "Em G também.", quotedProviderMessageId: "M-2" });
    expect(provider.sentMessages.at(-1)).not.toHaveProperty("mentionedPhones");
  });

  it("interruptores desligados ou sala inativa: pula sem chamar o modelo", async () => {
    await registered();
    const recorded = await processGroupInbound(sdb, { messageId: "M-1", phone: GROUP, participantPhone: "5591999990001", text: "@Lia oi" }, { now: NOW });
    const signalId = (recorded as { signalId: string }).signalId;
    await db.update(schema.settings).set({ value: false }).where(eq(schema.settings.key, "bot_enabled"));
    expect(await runGroupMentionTurn(sdb, assistant, provider, { signalId, now: NOW })).toEqual({ skipped: "bot_desligado" });
    await db.update(schema.settings).set({ value: true }).where(eq(schema.settings.key, "bot_enabled"));
    await db.update(schema.waGroups).set({ isActive: false });
    expect(await runGroupMentionTurn(sdb, assistant, provider, { signalId, now: NOW })).toEqual({ skipped: "sala_inativa" });
    expect(assistant.inputs).toHaveLength(0);
    expect(await runGroupMentionTurn(sdb, assistant, provider, { signalId: "00000000-0000-4000-8000-000000000000", now: NOW })).toEqual({ skipped: "inexistente" });
  });
});

describe("o Provador no caderninho", () => {
  it("voto, reação (com as peças do post) e menção viram linhas; loadMemoryLines inclui", async () => {
    const { productId } = await pricedProduct("Vestido Terracota", "Vestidos", [{ size: "M", color: "terracota", onHand: 3 }]);
    const group = await registered();
    const post = await scheduleGroupPost(sdb, { groupId: group.id, scheduledAt: NOW, userId: FIXED_USER_ID, post: { kind: "chegadas", productIds: [productId] } }, { now: NOW });
    await sendGroupPost(sdb, provider, { postId: post.id, now: NOW });
    const postMessageId = provider.sentMessages[0]!.providerMessageId;
    await processGroupInbound(sdb, { messageId: "R-1", phone: GROUP, participantPhone: "5591999990001", reaction: { value: "❤️", reactionBy: "5591999990001", referencedMessage: { messageId: postMessageId } } }, { now: sp("2026-09-22", 11) });
    await processGroupInbound(sdb, { messageId: "M-1", phone: GROUP, participantPhone: "5591999990001", text: "@Lia tem em M?" }, { now: sp("2026-09-22", 12) });
    const lines = await groupMemoryLines(sdb, ANA);
    expect(lines).toEqual([
      "Provador: chamou você no grupo (terça 22/09): «@Lia tem em M?»",
      "Provador: reagiu ❤️ ao Passou pelo Provador de terça 22/09 (Vestido Terracota)",
    ]);
    expect(await loadMemoryLines(sdb, ANA)).toEqual(expect.arrayContaining(lines));
    expect(await groupMemoryLines(sdb, BIA)).toEqual([]);
  });
});

describe("só privado e SAIR", () => {
  it("'só privado' marca a saída, enfileira a remoção e confirma; SAIR também sai das salas; a remoção passa pelo provedor", async () => {
    await customer("Ana Souza", ANA);
    const group = await registered();
    const base = { instanceId: "i", isGroup: false, fromMe: false, momment: 1, status: "RECEIVED", type: "ReceivedCallback" };
    const result = await processZapiInbound(sdb, { providedSecret: "segredo", body: { ...base, messageId: "W-1", phone: "5591999990001", senderName: "Ana", text: { message: "Só privado" } } });
    expect(result).toMatchObject({ action: "so_privado", groups: 1 });
    const [member] = await db.select().from(schema.waGroupMembers).where(and(eq(schema.waGroupMembers.groupId, group.id), eq(schema.waGroupMembers.phoneE164, ANA)));
    expect(member).toMatchObject({ leftReason: "so_privado" });
    expect(member.leftAt).not.toBeNull();
    const removes = await outbox("wa.group_remove");
    expect(removes).toHaveLength(1);
    expect(removes[0]?.payload).toMatchObject({ phoneE164: ANA, reason: "so_privado" });
    const acks = await outbox("wa.send");
    expect(String((acks[0]?.payload as { body: string }).body)).toContain("te tirei do Provador");
    // Ela ainda tem opt-in (só privado ≠ SAIR).
    expect((await db.select().from(schema.customers))[0]?.marketingOptIn).toBe(true);

    // Enquanto a remoção não acontece, o sync (ela ainda aparece no metadata) NÃO a traz de volta.
    await syncGroupMembers(sdb, provider, { groupId: group.id, now: new Date(NOW.getTime() + 60_000) });
    expect((await db.select().from(schema.waGroupMembers).where(eq(schema.waGroupMembers.phoneE164, ANA)))[0]).toMatchObject({ leftReason: "so_privado" });

    expect(await removeFromGroups(sdb, provider, { phoneE164: ANA })).toEqual({ removed: 1 });
    expect(provider.removedParticipants).toEqual([{ groupId: GROUP, addresses: [ANA] }]);
    // Saída antiga (mais de 7 dias) não é refeita. O `leftAt` foi gravado por
    // processZapiInbound, que usa o relógio REAL (é a porta do webhook, não
    // tem now injetável) — então os 8 dias contam a partir dele, não do NOW
    // fixo, senão o teste passa ou falha conforme a hora em que roda.
    expect(await removeFromGroups(sdb, provider, { phoneE164: ANA, now: new Date(Date.now() + 8 * 86_400_000) })).toEqual({ removed: 0 });

    // Quem não está em grupo nenhum recebe outra frase.
    const again = await processZapiInbound(sdb, { providedSecret: "segredo", body: { ...base, messageId: "W-2", phone: "5591999990001", text: { message: "só privado" } } });
    expect(again).toMatchObject({ action: "so_privado", groups: 0 });

    // Número oculto (linha da sala pelo LID): "só privado" também acha.
    const LID = "220839349862480@lid";
    provider.setGroup(metadata([{ phoneE164: "+5591981037536", lid: null, isAdmin: true }, { phoneE164: BIA, lid: null, isAdmin: false }, { phoneE164: null, lid: LID, isAdmin: false }]));
    await syncGroupMembers(sdb, provider, { groupId: group.id, now: new Date(NOW.getTime() + 120_000) });
    const lidResult = await processZapiInbound(sdb, { providedSecret: "segredo", body: { ...base, messageId: "W-L", phone: LID, chatLid: LID, text: { message: "só privado" } } });
    expect(lidResult).toMatchObject({ action: "so_privado", groups: 1 });
    expect(await removeFromGroups(sdb, provider, { phoneE164: LID })).toEqual({ removed: 1 });
    expect(provider.removedParticipants.at(-1)).toEqual({ groupId: GROUP, addresses: [LID] });

    // SAIR de quem está no grupo: sai da sala e desliga tudo.
    await customer("Bia", BIA);
    const sair = await processZapiInbound(sdb, { providedSecret: "segredo", body: { ...base, messageId: "W-3", phone: "5591999990002", text: { message: "SAIR" } } });
    expect(sair).toMatchObject({ action: "opt_out" });
    const [bia] = await db.select().from(schema.waGroupMembers).where(eq(schema.waGroupMembers.phoneE164, BIA));
    expect(bia).toMatchObject({ leftReason: "removida" });
    expect(await outbox("wa.group_remove")).toHaveLength(3);
  });
});

describe("avisos no privado", () => {
  it("afinidade: depois do Passou pelo Provador, quem tem o tamanho (e a cor) recebe UM aviso, de 5 em 5 min, com opt-in; quem não pontua, não", async () => {
    const { productId } = await pricedProduct("Vestido Terracota", "Vestidos", [{ size: "M", color: "terracota", onHand: 3 }, { size: "G", color: "terracota", onHand: 1 }]);
    const anaId = await customer("Ana Souza", ANA, { sizes: { vestido: "M" }, colorsLove: ["terracota"] });
    await customer("Bia", BIA, { sizes: { vestido: "PP" } }); // sem o tamanho
    const group = await registered();
    const post = await scheduleGroupPost(sdb, { groupId: group.id, scheduledAt: NOW, userId: FIXED_USER_ID, post: { kind: "chegadas", productIds: [productId] } }, { now: NOW });
    await sendGroupPost(sdb, provider, { postId: post.id, now: NOW });
    const [fanout] = await outbox("wa.group_affinity_fanout");
    expect(fanout?.payload).toEqual({ postId: post.id });

    expect(await fanOutAffinityNotices(sdb, { postId: post.id, now: NOW })).toEqual({ queued: 1, candidates: 2 });
    const notices = await outbox("wa.group_affinity_notice");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ dedupeKey: `wa.group_affinity_notice:${post.id}:${anaId}`, nextAttemptAt: NOW });
    // Segundo fan-out não duplica.
    expect(await fanOutAffinityNotices(sdb, { postId: post.id, now: NOW })).toEqual({ queued: 0, candidates: 2 });

    const sent = await sendAffinityNotice(sdb, provider, { postId: post.id, customerId: anaId, now: sp("2026-09-22", 10, 5) });
    expect(sent).toMatchObject({ sent: true });
    expect(provider.sentMessages.at(-1)).toMatchObject({ toE164: ANA, body: "Ana: Vestido Terracota tem no seu tamanho (M) e em terracota, que é a sua cor — M por 24 h?" });
    // Idempotente: o retry não manda de novo (dedupe em wa_messages).
    expect(await sendAffinityNotice(sdb, provider, { postId: post.id, customerId: anaId, now: sp("2026-09-22", 10, 6) })).toEqual({ skipped: "ja_enviado" });
    expect(provider.sentMessages.filter((m) => m.toE164 === ANA)).toHaveLength(1);

    // Fora da janela adia para o próximo instante publicável (segunda 9h quando cai no domingo).
    const late = await scheduleGroupPost(sdb, { groupId: group.id, scheduledAt: sp("2026-09-26", 10), userId: FIXED_USER_ID, post: { kind: "chegadas", productIds: [productId] } }, { now: NOW });
    await sendGroupPost(sdb, provider, { postId: late.id, now: sp("2026-09-26", 10) });
    expect(await sendAffinityNotice(sdb, provider, { postId: late.id, customerId: anaId, now: sp("2026-09-26", 22) })).toEqual({ skipped: "fora_da_janela" });
    const deferred = (await outbox("wa.group_affinity_notice")).find((e) => e.dedupeKey === `wa.group_affinity_notice:${late.id}:${anaId}:2026-09-26`);
    expect(deferred?.nextAttemptAt).toEqual(sp("2026-09-28", 9));

    // Sem opt-in: nada.
    await db.update(schema.customers).set({ marketingOptIn: false }).where(eq(schema.customers.id, anaId));
    expect(await sendAffinityNotice(sdb, provider, { postId: late.id, customerId: anaId, now: sp("2026-09-28", 9) })).toEqual({ skipped: "sem_opt_in" });
  });

  it("cor amada ou categoria comprada sem o TAMANHO na peça não recebem o aviso (a promessa é 'no seu tamanho')", async () => {
    const { productId } = await pricedProduct("Vestido Terracota", "Vestidos", [{ size: "G", color: "terracota", onHand: 3 }]);
    const anaId = await customer("Ana Souza", ANA, { sizes: { vestido: "M" }, colorsLove: ["terracota"] }); // cor sim, tamanho não
    const group = await registered();
    const post = await scheduleGroupPost(sdb, { groupId: group.id, scheduledAt: NOW, userId: FIXED_USER_ID, post: { kind: "chegadas", productIds: [productId] } }, { now: NOW });
    await sendGroupPost(sdb, provider, { postId: post.id, now: NOW });
    expect(await fanOutAffinityNotices(sdb, { postId: post.id, now: NOW })).toEqual({ queued: 0, candidates: 1 });
    expect(await sendAffinityNotice(sdb, provider, { postId: post.id, customerId: anaId, now: sp("2026-09-22", 10, 5) })).toEqual({ skipped: "sem_afinidade" });
  });

  it("intervalo entre avisos ativos é de 5 min (nunca os 20 s do lote)", async () => {
    const { productId } = await pricedProduct("Blusa Marfim", "Blusas", [{ size: "M", color: "marfim", onHand: 5 }]);
    const ids = [];
    for (const [index, phone] of [ANA, BIA, "+5591999990003"].entries()) {
      ids.push(await customer(`Cliente ${index}`, phone, { sizes: { blusa: "M" } }));
    }
    provider.setGroup(metadata([{ phoneE164: ANA, lid: null, isAdmin: false }, { phoneE164: BIA, lid: null, isAdmin: false }, { phoneE164: "+5591999990003", lid: null, isAdmin: false }]));
    const group = await registered();
    const post = await scheduleGroupPost(sdb, { groupId: group.id, scheduledAt: NOW, userId: FIXED_USER_ID, post: { kind: "chegadas", productIds: [productId] } }, { now: NOW });
    await sendGroupPost(sdb, provider, { postId: post.id, now: NOW });
    expect(await fanOutAffinityNotices(sdb, { postId: post.id, now: NOW })).toMatchObject({ queued: 3 });
    const times = (await outbox("wa.group_affinity_notice")).map((e) => e.nextAttemptAt!.getTime()).sort();
    expect(times[1]! - times[0]!).toBe(GROUP_NOTICE_INTERVAL_SECONDS * 1000);
    expect(times[2]! - times[1]!).toBe(GROUP_NOTICE_INTERVAL_SECONDS * 1000);
    expect(ids).toHaveLength(3);
  });

  it("última unidade: a venda que deixa 1 dispara stock.last_unit; quem reagiu ao post e veste o tamanho recebe uma vez por semana; se repôs, não manda", async () => {
    const { productId, variantIds } = await pricedProduct("Calça Areia", "Calças", [{ size: "M", color: "areia", onHand: 2 }]);
    const anaId = await customer("Ana Souza", ANA, { sizes: { calca: "M" } });
    await customer("Bia", BIA, { sizes: { calca: "G" } });
    const group = await registered();
    const post = await scheduleGroupPost(sdb, { groupId: group.id, scheduledAt: NOW, userId: FIXED_USER_ID, post: { kind: "chegadas", productIds: [productId] } }, { now: NOW });
    await sendGroupPost(sdb, provider, { postId: post.id, now: NOW });
    const postMessageId = provider.sentMessages[0]!.providerMessageId;
    for (const [id, phone] of [["R-1", "5591999990001"], ["R-2", "5591999990002"]]) {
      await processGroupInbound(sdb, { messageId: id, phone: GROUP, participantPhone: phone, reaction: { value: "❤️", reactionBy: phone, referencedMessage: { messageId: postMessageId } } }, { now: NOW });
    }
    // Vendeu uma: sobrou a última.
    await adjustStock(sdb, { variantId: variantIds[0]!, quantityDelta: -1, note: "venda", userId: FIXED_USER_ID });
    const events = await outbox("stock.last_unit");
    expect(events).toHaveLength(1);
    const payload = events[0]!.payload as { variantId: string; movementId: string };
    expect(await fanOutLastUnitNotices(sdb, { ...payload, now: sp("2026-09-22", 11) })).toEqual({ queued: 1 });
    const notices = await outbox("wa.group_last_unit_notice");
    expect(notices[0]?.payload).toEqual({ variantId: variantIds[0], customerId: anaId, postId: post.id });

    expect(await sendLastUnitNotice(sdb, provider, { variantId: variantIds[0]!, customerId: anaId, postId: post.id, now: sp("2026-09-22", 11) })).toEqual({ sent: true });
    expect(provider.sentMessages.at(-1)).toMatchObject({ toE164: ANA, body: "Ana, ficou uma Calça Areia em M." });
    // Uma por semana: um segundo aviso (outra peça) na mesma semana pula.
    expect(await sendLastUnitNotice(sdb, provider, { variantId: variantIds[0]!, customerId: anaId, postId: post.id, now: sp("2026-09-23", 11) })).toEqual({ skipped: "uma_por_semana" });
    // Repôs: não é mais a última.
    await adjustStock(sdb, { variantId: variantIds[0]!, quantityDelta: 3, note: "reposição", userId: FIXED_USER_ID });
    expect(await sendLastUnitNotice(sdb, provider, { variantId: variantIds[0]!, customerId: anaId, postId: post.id, now: sp("2026-09-30", 11) })).toEqual({ skipped: "nao_e_mais_a_ultima" });
  });

  it("vencedora da enquete chegou: a reposição da cor vencedora avisa quem votou nela (e só quem tem opt-in)", async () => {
    const { productId, variantIds } = await pricedProduct("Blusa Marfim", "Blusas", [{ size: "M", color: "marfim", onHand: 3 }, { size: "M", color: "verde-oliva", onHand: 0 }]);
    const anaId = await customer("Ana Souza", ANA);
    await customer("Bia", BIA, { optIn: false });
    const group = await registered();
    const poll = await scheduleGroupPost(
      sdb,
      { groupId: group.id, scheduledAt: sp("2026-09-24", 19), userId: FIXED_USER_ID, post: { kind: "enquete", question: "Qual cor?", options: ["Verde-oliva", "Vinho"], productId } },
      { now: NOW },
    );
    await sendGroupPost(sdb, provider, { postId: poll.id, now: sp("2026-09-24", 19) });
    const pollMessageId = provider.sentPolls[0]!.providerMessageId;
    for (const [id, phone, option] of [["V-1", "5591999990001", "Verde-oliva"], ["V-2", "5591999990002", "Verde-oliva"], ["V-3", "5591999990003", "Vinho"]]) {
      await processGroupInbound(sdb, { messageId: id, phone: GROUP, participantPhone: phone, pollVote: { pollMessageId, options: [{ name: option }] } }, { now: sp("2026-09-24", 20) });
    }
    expect(await closeGroupPoll(sdb, provider, { postId: poll.id, now: sp("2026-09-26", 11) })).toMatchObject({ closed: true, winner: "Verde-oliva" });

    // Chegou a verde-oliva.
    await adjustStock(sdb, { variantId: variantIds[1]!, quantityDelta: 4, note: "chegou", userId: FIXED_USER_ID });
    const restocked = await outbox("stock.restocked");
    expect(restocked).toHaveLength(1);
    const payload = restocked[0]!.payload as { variantId: string; movementId: string };
    expect(await fanOutPollWinnerNotices(sdb, { ...payload, now: sp("2026-09-29", 10) })).toEqual({ queued: 1 });
    const notices = await outbox("wa.group_poll_winner_notice");
    expect(notices[0]?.payload).toEqual({ postId: poll.id, variantId: variantIds[1], customerId: anaId });
    expect(await sendPollWinnerNotice(sdb, provider, { postId: poll.id, variantId: variantIds[1]!, customerId: anaId, now: sp("2026-09-29", 10) })).toMatchObject({ sent: true });
    expect(provider.sentMessages.at(-1)).toMatchObject({ toE164: ANA, body: "Deu Verde-oliva: Blusa Marfim chegou (4), 24 h de reserva." });

    // "Verde" não casa com "verde-oliva" (só igualdade exata): uma variação "verde" não avisa.
    const [verde] = await db.insert(schema.productVariants).values({ productId, sku: "MARFIM-VERDE-M", costCents: 1000, attributes: { tamanho: "M", cor: "verde" } }).returning({ id: schema.productVariants.id });
    await db.insert(schema.stockLevels).values({ productVariantId: verde.id, onHand: 0, reserved: 0 });
    await adjustStock(sdb, { variantId: verde.id, quantityDelta: 2, note: "chegou", userId: FIXED_USER_ID });
    const verdeEvent = (await outbox("stock.restocked")).find((e) => (e.payload as { variantId: string }).variantId === verde.id);
    expect(await fanOutPollWinnerNotices(sdb, { ...(verdeEvent!.payload as { variantId: string; movementId: string }), now: sp("2026-09-29", 11) })).toEqual({ queued: 0 });

    // A reposição da cor que NÃO ganhou não avisa ninguém.
    await adjustStock(sdb, { variantId: variantIds[0]!, quantityDelta: -3, note: "zerou", userId: FIXED_USER_ID });
    await adjustStock(sdb, { variantId: variantIds[0]!, quantityDelta: 2, note: "voltou", userId: FIXED_USER_ID });
    const second = (await outbox("stock.restocked")).find((e) => (e.payload as { variantId: string }).variantId === variantIds[0]);
    expect(await fanOutPollWinnerNotices(sdb, { ...(second!.payload as { variantId: string; movementId: string }), now: sp("2026-09-29", 12) })).toEqual({ queued: 0 });
  });
});
