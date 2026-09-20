// A rota do webhook da Z-API responde 200 ANTES do turno da Lia e agenda o
// turno inline (after) só quando a mensagem gerou um evento do outbox; secret
// errado é 404 sem agendar nada; erro no inline nunca vira 500 (a resposta já
// saiu). O serviço, a fila e o banco são dublês: aqui só a rota importa.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const afterTasks: Array<() => Promise<void> | void> = [];
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (task: () => Promise<void> | void) => {
      afterTasks.push(task);
    },
  };
});
const processZapiInbound = vi.fn();
vi.mock("@/services/wa-inbound", () => ({ processZapiInbound: (...args: unknown[]) => processZapiInbound(...args) }));
const runOutboxKick = vi.fn();
vi.mock("@/queue/kick", () => ({ INLINE_KICK_BUDGET_MS: 45_000, WEBHOOK_INLINE_MAX_MS: 55_000, runOutboxKick: (...args: unknown[]) => runOutboxKick(...args) }));
const fakeDb = { fake: true };
vi.mock("@/db/client", () => ({ getDb: () => fakeDb }));

const { POST, maxDuration } = await import("@/app/api/webhooks/zapi/[secret]/route");

const SECRET = "s3cret";
function post(body: unknown, secret = SECRET) {
  const request = new Request(`http://localhost/api/webhooks/zapi/${secret}`, {
    method: "POST",
    headers: { "content-type": "application/json", "client-token": "tok" },
    body: JSON.stringify(body),
  });
  return POST(request as never, { params: Promise.resolve({ secret }) });
}

beforeEach(() => {
  afterTasks.length = 0;
  processZapiInbound.mockReset();
  runOutboxKick.mockReset();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/webhooks/zapi/[secret]", () => {
  it("vive até 60 s: o turno inline roda depois do 200", () => {
    expect(maxDuration).toBe(60);
  });

  it("mensagem que enfileirou o turno: 200 na hora e o turno agendado em after, com o id, origem inline e o orçamento inline", async () => {
    processZapiInbound.mockResolvedValue({ action: "bot_queued", conversationId: "c1", waMessageId: "m1", outboxEventId: "e1" });
    runOutboxKick.mockResolvedValue({ target: "processada" });

    const response = await post({ messageId: "MSG-1", phone: "5511999998888", text: { message: "oi" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(processZapiInbound).toHaveBeenCalledWith(fakeDb, expect.objectContaining({ providedSecret: SECRET, clientToken: "tok", body: expect.objectContaining({ messageId: "MSG-1" }) }));
    // O turno não rodou ainda (a resposta saiu primeiro)…
    expect(runOutboxKick).not.toHaveBeenCalled();
    expect(afterTasks).toHaveLength(1);
    // …e roda quando o after dispara.
    await afterTasks[0]();
    expect(runOutboxKick).toHaveBeenCalledWith(fakeDb, { outboxEventId: "e1", source: "inline", budgetMs: 45_000 });
  });

  it("o orçamento do inline é o que sobra da lambda: registro que esperou 20 s ganha 35 s, não 45", async () => {
    vi.useFakeTimers();
    try {
      processZapiInbound.mockImplementation(async () => {
        vi.advanceTimersByTime(20_000);
        return { action: "bot_queued", conversationId: "c1", waMessageId: "m1", outboxEventId: "e3" };
      });
      runOutboxKick.mockResolvedValue({ target: "processada" });
      await post({ messageId: "MSG-6" });
      await afterTasks[0]();
      expect(runOutboxKick).toHaveBeenCalledWith(fakeDb, { outboxEventId: "e3", source: "inline", budgetMs: 35_000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("erro dentro do turno inline não sobe (o kick e o cron cobrem)", async () => {
    processZapiInbound.mockResolvedValue({ action: "forwarded", conversationId: "c1", waMessageId: "m1", outboxEventId: "e2" });
    runOutboxKick.mockRejectedValue(new Error("banco caiu"));
    const response = await post({ messageId: "MSG-2" });
    expect(response.status).toBe(200);
    await expect(afterTasks[0]()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledOnce();
  });

  it("secret errado: 404 e nada agendado", async () => {
    processZapiInbound.mockResolvedValue({ action: "rejected", rejected: "secret" });
    const response = await post({ messageId: "MSG-3" }, "errado");
    expect(response.status).toBe(404);
    expect(afterTasks).toHaveLength(0);
  });

  it("duplicado, status, ignorado e evento já existente (dedupe): 200 sem agendar nada", async () => {
    for (const result of [
      { action: "duplicate", duplicate: true },
      { action: "status", updated: 1 },
      { action: "ignored", ignored: true },
      { action: "bot_queued", conversationId: "c1", waMessageId: "m1", outboxEventId: null },
    ]) {
      processZapiInbound.mockResolvedValueOnce(result);
      const response = await post({ messageId: "MSG-4" });
      expect(response.status).toBe(200);
    }
    expect(afterTasks).toHaveLength(0);
  });

  it("serviço que lança: 200 mesmo assim (a Z-API não pode desativar o webhook) e nada agendado", async () => {
    processZapiInbound.mockRejectedValue(new Error("boom"));
    const response = await post({ messageId: "MSG-5" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(afterTasks).toHaveLength(0);
    expect(console.error).toHaveBeenCalledOnce();
  });
});
