// O "toque" da conversa (última entrada, LID/cliente, nome, notas, ponte):
// aplicado na hora quando a linha está livre; quando o turno da Lia a segura,
// o webhook não espera — o toque vai para a fila e o turno o aplica ao pegar
// a vez. O PGlite tem uma conexão só (não dá para prender a linha de verdade):
// o caminho "presa" é exercitado pelo erro 55P03 que o Postgres lançaria.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeSalesAssistant } from "@/adapters/assistant/fake";
import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { runBotTurn } from "@/services/wa-bot";
import {
  applyConversationTouch,
  applyPendingConversationTouches,
  CONVERSATION_TOUCH_EVENT,
  isLockTimeoutError,
  touchConversationOrDefer,
  type ConversationTouch,
} from "@/services/wa-conversation-touch";
import { createTestDb, type TestDb } from "../helpers/db";

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

async function conversation(botState: Record<string, unknown> = {}): Promise<string> {
  const [row] = await db
    .insert(schema.waConversations)
    .values({ phoneE164: "+5591999990000", status: "open", botState, lastInboundAt: new Date("2026-09-20T10:00:00Z") })
    .returning({ id: schema.waConversations.id });
  return row.id;
}

async function row(id: string) {
  const [r] = await db.select().from(schema.waConversations).where(eq(schema.waConversations.id, id));
  return r;
}

const bridge = {
  siteCartId: "33333333-3333-4333-8333-333333333333",
  source: "cart" as const,
  code: "K7F2",
  at: "2026-09-20T12:00:00.000Z",
  items: [{ sku: "DUNAS-PRET-M", name: "Longo Dunas", quantity: 1, variation: "Preto · M", priceCents: 28900 }],
};

describe("applyConversationTouch", () => {
  it("é idempotente e nunca regride: última entrada por greatest, LID/cliente por coalesce, nome e notas por merge, ponte fundida na sacola", async () => {
    const id = await conversation({ notes: ["veste M"] });
    const touch: ConversationTouch = {
      conversationId: id,
      inboundAt: "2026-09-20T12:00:00.000Z",
      lid: "123@lid",
      displayName: "Ana",
      notes: ["antiga"],
      bridge,
    };
    await applyConversationTouch(sdb, touch);
    await applyConversationTouch(sdb, touch);
    // Um toque mais ANTIGO chegando depois (replay fora de ordem) não mexe na última entrada.
    await applyConversationTouch(sdb, { conversationId: id, inboundAt: "2026-09-20T11:00:00.000Z", displayName: "Ana Paula" });
    const r = await row(id);
    expect(r.lastInboundAt?.toISOString()).toBe("2026-09-20T12:00:00.000Z");
    expect(r.lid).toBe("123@lid");
    const state = r.botState as { displayName: string; notes: string[]; cart: { sku: string; quantidade: number }[]; bridge: { code: string } };
    expect(state.displayName).toBe("Ana Paula");
    expect(state.notes).toEqual(["antiga"]);
    expect(state.cart).toEqual([expect.objectContaining({ sku: "DUNAS-PRET-M", quantidade: 1, precoCents: 28900 })]);
    expect(state.bridge.code).toBe("K7F2");
  });
});

describe("touchConversationOrDefer", () => {
  it("linha livre: aplica na hora e não enfileira nada", async () => {
    const id = await conversation();
    const eventId = await touchConversationOrDefer(sdb, { conversationId: id, inboundAt: "2026-09-20T12:00:00.000Z", displayName: "Ana" });
    expect(eventId).toBeNull();
    expect((await row(id)).botState).toMatchObject({ displayName: "Ana" });
    expect(await db.select().from(schema.outboxEvents)).toHaveLength(0);
  });

  it("linha presa (55P03 no savepoint): a transação de quem chama segue e o toque vai para a fila, datado ANTES do turno", async () => {
    const id = await conversation();
    const touch: ConversationTouch = { conversationId: id, inboundAt: "2026-09-20T12:00:00.000Z", displayName: "Ana", bridge };
    let eventId: string | null = null;
    await db.transaction(async (tx) => {
      const tdb = tx as unknown as DbOrTx;
      // O savepoint é o `transaction` aninhado: aqui ele estoura como o Postgres estouraria o lock_timeout.
      const spy = vi.spyOn(tdb as unknown as { transaction: (fn: unknown) => Promise<unknown> }, "transaction").mockRejectedValueOnce(Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }));
      eventId = await touchConversationOrDefer(tdb, touch);
      spy.mockRestore();
      // A transação continua viva: outra escrita funciona.
      await tx.insert(schema.waMessages).values({ conversationId: id, direction: "inbound", kind: "text", body: "oi", status: "delivered", zapiMessageId: "MSG-T-1" });
    });
    expect(eventId).not.toBeNull();
    const [event] = await db.select().from(schema.outboxEvents);
    expect(event).toMatchObject({ eventType: CONVERSATION_TOUCH_EVENT, aggregateId: id, status: "pending", payload: touch });
    expect(event.nextAttemptAt.getTime()).toBeLessThan(Date.now());
    expect((await row(id)).botState).toEqual({});

    // O turno seguinte aplica o toque pendente antes de responder: a Lia vê o nome e a ponte.
    const assistant = new FakeSalesAssistant();
    const provider = new FakeMessagingProvider();
    await db.insert(schema.settings).values([{ key: "wa_enabled", value: true }, { key: "bot_enabled", value: true }]);
    await runBotTurn(sdb, assistant, provider, { conversationId: id });
    const note = assistant.inputs.at(-1)?.history[0]?.text ?? "";
    expect(note).toContain("Nome no WhatsApp: Ana");
    expect(note).toContain("Veio do site");
    const [done] = await db.select().from(schema.outboxEvents);
    expect(done.status).toBe("done");
    expect((await row(id)).botState).toMatchObject({ displayName: "Ana", bridge: { code: "K7F2" } });
  });

  it("applyPendingConversationTouches: aplica só os pendentes desta conversa, na ordem, e marca done; payload torto é ignorado sem travar", async () => {
    const a = await conversation();
    const [b] = await db.insert(schema.waConversations).values({ phoneE164: "+5591999990001", status: "open" }).returning({ id: schema.waConversations.id });
    await db.insert(schema.outboxEvents).values([
      { eventType: CONVERSATION_TOUCH_EVENT, aggregateType: "wa_conversation", aggregateId: a, payload: { conversationId: a, inboundAt: "2026-09-20T12:00:00.000Z", displayName: "Primeira" } },
      { eventType: CONVERSATION_TOUCH_EVENT, aggregateType: "wa_conversation", aggregateId: a, payload: { conversationId: a, inboundAt: "2026-09-20T12:01:00.000Z", displayName: "Segunda" } },
      { eventType: CONVERSATION_TOUCH_EVENT, aggregateType: "wa_conversation", aggregateId: a, payload: { torto: true } },
      { eventType: CONVERSATION_TOUCH_EVENT, aggregateType: "wa_conversation", aggregateId: b.id, payload: { conversationId: b.id, inboundAt: "2026-09-20T12:00:00.000Z", displayName: "Outra" } },
    ]);
    expect(await applyPendingConversationTouches(sdb, a)).toBe(3);
    expect((await row(a)).botState).toMatchObject({ displayName: "Segunda" });
    expect((await row(b.id)).botState).toBeNull();
    const events = await db.select({ aggregateId: schema.outboxEvents.aggregateId, status: schema.outboxEvents.status, lastError: schema.outboxEvents.lastError }).from(schema.outboxEvents);
    expect(events.filter((e) => e.aggregateId === a).map((e) => e.status)).toEqual(["done", "done", "done"]);
    expect(events.find((e) => e.lastError)?.lastError).toContain("payload inválido");
    expect(events.find((e) => e.aggregateId === b.id)?.status).toBe("pending");
  });

  it("isLockTimeoutError reconhece o 55P03 cru e embrulhado pelo drizzle", () => {
    expect(isLockTimeoutError(Object.assign(new Error("x"), { code: "55P03" }))).toBe(true);
    expect(isLockTimeoutError(Object.assign(new Error("Failed query"), { cause: { code: "55P03" } }))).toBe(true);
    expect(isLockTimeoutError(Object.assign(new Error("x"), { code: "23505" }))).toBe(false);
    expect(isLockTimeoutError(null)).toBe(false);
  });
});
