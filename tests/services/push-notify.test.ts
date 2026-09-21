// Handler push.new_message: relê a conversa, avisa cada aparelho, respeita
// quem já leu, apaga inscrição morta e deixa a falha transitória para a fila.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakePushProvider } from "@/adapters/push/fake";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { sendPushForConversation } from "@/services/push-notify";
import { upsertPushSubscription } from "@/services/push-subscriptions";

import { createTestDb, createTestUser, FIXED_USER_ID, type TestDb } from "../helpers/db";

const KEYS = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" };

describe("sendPushForConversation", () => {
  let db: TestDb;
  let sdb: DbOrTx;
  let close: () => Promise<void>;
  let provider: FakePushProvider;

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    sdb = db as unknown as DbOrTx;
    provider = new FakePushProvider();
    vi.stubEnv("ADAPTER_MODE", "fake");
    await db.insert(schema.settings).values([
      { key: "wa_enabled", value: true },
      { key: "bot_enabled", value: true },
      { key: "owner_whatsapp_phone", value: "+5511955550000" },
    ]);
  });
  afterEach(async () => {
    await close();
    vi.unstubAllEnvs();
  });

  async function conversation(overrides: Partial<typeof schema.waConversations.$inferInsert> = {}, inbound = "tem em M?") {
    const [row] = await db
      .insert(schema.waConversations)
      .values({ phoneE164: "+5511999990000", status: "open", ...overrides })
      .returning({ id: schema.waConversations.id });
    const [message] = await db
      .insert(schema.waMessages)
      .values({ conversationId: row.id, direction: "inbound", body: inbound, status: "delivered", createdAt: new Date("2026-09-21T12:00:00Z") })
      .returning({ id: schema.waMessages.id });
    return { conversationId: row.id, waMessageId: message.id };
  }

  it("manda para cada aparelho inscrito de usuários ativos, com o nome do WhatsApp e a prévia", async () => {
    const staff = await createTestUser(db);
    const inactive = await createTestUser(db, { isActive: false });
    await upsertPushSubscription(sdb, { userId: FIXED_USER_ID, endpoint: "https://push.example/owner", keys: KEYS });
    await upsertPushSubscription(sdb, { userId: staff.id, endpoint: "https://push.example/staff", keys: KEYS });
    await upsertPushSubscription(sdb, { userId: inactive.id, endpoint: "https://push.example/inactive", keys: KEYS });
    const ids = await conversation({ botState: { displayName: "Bia" } }, "  tem   em M? ");

    const result = await sendPushForConversation(sdb, provider, ids);
    expect(result).toEqual({ sent: 2, removed: 0, alreadySent: 0 });
    expect(provider.sent.map((item) => item.endpoint).sort()).toEqual(["https://push.example/owner", "https://push.example/staff"]);
    expect(provider.sent[0].payload).toEqual({
      title: "Nova mensagem de Bia",
      body: "tem em M?",
      url: `/admin/whatsapp/conversas?c=${ids.conversationId}`,
      tag: ids.conversationId,
    });
    const rows = await db.select().from(schema.pushSubscriptions);
    expect(rows.filter((row) => row.lastOkAt !== null)).toHaveLength(2);
  });

  it("'esperando por você' quando é com o dono: transferida, vendedora em pausa ou vendedora desligada", async () => {
    await upsertPushSubscription(sdb, { userId: FIXED_USER_ID, endpoint: "https://push.example/owner", keys: KEYS });
    const [customer] = await db.insert(schema.customers).values({ fullName: "Ana Compradora", phoneE164: "+5511999990000" }).returning({ id: schema.customers.id });

    const human = await conversation({ status: "human", customerId: customer.id });
    await sendPushForConversation(sdb, provider, human);
    expect(provider.sent.at(-1)?.payload.title).toBe("Ana Compradora está esperando por você");

    const paused = await conversation({ phoneE164: "+5511888880000", botDisabledUntil: new Date(Date.now() + 3_600_000) });
    await sendPushForConversation(sdb, provider, paused);
    // Sem cadastro nem nome do WhatsApp: o telefone mascarado.
    expect(provider.sent.at(-1)?.payload.title).toMatch(/^\(11\) .*0000 está esperando por você$/);

    await db.update(schema.settings).set({ value: false }).where((await import("drizzle-orm")).eq(schema.settings.key, "bot_enabled"));
    const open = await conversation({ phoneE164: "+5511777770000" });
    await sendPushForConversation(sdb, provider, open);
    expect(provider.sent.at(-1)?.payload.title).toContain("está esperando por você");
  });

  it("pula: conversa já vista, encerrada, avisos internos e sem inscrição", async () => {
    const noSubscription = await conversation();
    expect(await sendPushForConversation(sdb, provider, noSubscription)).toEqual({ skipped: "sem_inscricoes" });

    await upsertPushSubscription(sdb, { userId: FIXED_USER_ID, endpoint: "https://push.example/owner", keys: KEYS });
    const seen = await conversation({ phoneE164: "+5511888880000", ownerLastSeenAt: new Date("2026-09-21T12:00:01Z") });
    expect(await sendPushForConversation(sdb, provider, seen)).toEqual({ skipped: "ja_vista" });
    const closed = await conversation({ phoneE164: "+5511777770000", status: "closed" });
    expect(await sendPushForConversation(sdb, provider, closed)).toEqual({ skipped: "encerrada" });
    const owner = await conversation({ phoneE164: "+5511955550000" });
    expect(await sendPushForConversation(sdb, provider, owner)).toEqual({ skipped: "avisos_internos" });
    expect(await sendPushForConversation(sdb, provider, { conversationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", waMessageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })).toEqual({ skipped: "conversa_inexistente" });
    expect(provider.sent).toHaveLength(0);
  });

  it("inscrição morta (410) some; falha transitória lança para a fila tentar de novo e fica registrada", async () => {
    await upsertPushSubscription(sdb, { userId: FIXED_USER_ID, endpoint: "https://push.example/ok", keys: KEYS });
    await upsertPushSubscription(sdb, { userId: FIXED_USER_ID, endpoint: "https://push.example/gone", keys: KEYS });
    const ids = await conversation();
    expect(await sendPushForConversation(sdb, provider, ids)).toEqual({ sent: 1, removed: 1, alreadySent: 0 });
    expect((await db.select().from(schema.pushSubscriptions)).map((row) => row.endpoint)).toEqual(["https://push.example/ok"]);

    await upsertPushSubscription(sdb, { userId: FIXED_USER_ID, endpoint: "https://push.example/fail", keys: KEYS });
    await expect(sendPushForConversation(sdb, provider, ids)).rejects.toThrow(/1 de 2 falharam/);
    const rows = await db.select().from(schema.pushSubscriptions);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.endpoint.endsWith("fail"))?.lastError).toContain("503");
    expect(provider.sent.filter((item) => item.endpoint.endsWith("/ok"))).toHaveLength(2);
  });

  it("repetição da fila depois de falha transitória: quem já recebeu (payload.sentTo do evento) não vibra de novo", async () => {
    await upsertPushSubscription(sdb, { userId: FIXED_USER_ID, endpoint: "https://push.example/ok", keys: KEYS });
    await upsertPushSubscription(sdb, { userId: FIXED_USER_ID, endpoint: "https://push.example/fail", keys: KEYS });
    const ids = await conversation();
    const [event] = await db
      .insert(schema.outboxEvents)
      .values({ eventType: "push.new_message", dedupeKey: "push.new_message:teste", payload: ids })
      .returning({ id: schema.outboxEvents.id });

    // 1ª tentativa: o bom recebe, o outro falha → lança, e o evento guarda quem recebeu.
    await expect(sendPushForConversation(sdb, provider, ids, { outboxEventId: event.id })).rejects.toThrow(/1 de 2 falharam/);
    const [after] = await db.select({ payload: schema.outboxEvents.payload }).from(schema.outboxEvents).where((await import("drizzle-orm")).eq(schema.outboxEvents.id, event.id));
    const okId = (await db.select().from(schema.pushSubscriptions)).find((row) => row.endpoint.endsWith("/ok"))!.id;
    expect((after.payload as { sentTo: string[] }).sentTo).toEqual([okId]);

    // 2ª tentativa (como a fila faz, com o payload atualizado): só o que faltava.
    const retryPayload = { ...ids, sentTo: (after.payload as { sentTo: string[] }).sentTo };
    await expect(sendPushForConversation(sdb, provider, retryPayload, { outboxEventId: event.id })).rejects.toThrow(/1 de 2 falharam/);
    expect(provider.sent.filter((item) => item.endpoint.endsWith("/ok"))).toHaveLength(1);

    // Outra conversa logo depois: o aparelho bom recebe (o marcador é por evento, não por aparelho).
    await db.delete(schema.pushSubscriptions).where((await import("drizzle-orm")).like(schema.pushSubscriptions.endpoint, "%fail"));
    const other = await conversation({ phoneE164: "+5511777770000" }, "outra cliente");
    expect(await sendPushForConversation(sdb, provider, other)).toEqual({ sent: 1, removed: 0, alreadySent: 0 });
    expect(provider.sent.at(-1)?.payload.body).toBe("outra cliente");
  });
});
