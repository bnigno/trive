// Respostas INTERATIVAS no webhook da Z-API (toque em lista de opções ou em
// botão): listResponseMessage/buttonsResponseMessage viram texto normal do
// fluxo — opção 'produto:{slug}' vira pedido de detalhe que o bot resolve por
// slug exato; dedupe por messageId e roteamento seguem intactos.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { processZapiInbound } from "@/services/wa-inbound";
import { createTestDb, type TestDb } from "../helpers/db";

const SECRET = "segredo-webhook-zapi";
// A Z-API entrega o telefone SEM o '+' do E.164.
const PHONE_ZAPI = "5511999990000";

function interactiveMessage(messageId: string, extra: Record<string, unknown>) {
  return {
    type: "ReceivedCallback",
    instanceId: "instancia-x",
    messageId,
    phone: PHONE_ZAPI,
    fromMe: false,
    isGroup: false,
    senderName: "Ana Cliente",
    momment: Date.now(),
    status: "RECEIVED",
    ...extra,
  };
}

describe("processZapiInbound → respostas interativas (lista e botão)", () => {
  let db: TestDb;
  let sdb: DbOrTx;
  let close: () => Promise<void>;
  const originalSecret = process.env.ZAPI_WEBHOOK_SECRET;

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    sdb = db as unknown as DbOrTx;
    process.env.ZAPI_WEBHOOK_SECRET = SECRET;
    delete process.env.ZAPI_CLIENT_TOKEN;
  });

  afterEach(async () => {
    await close();
    vi.unstubAllEnvs();
    if (originalSecret === undefined) delete process.env.ZAPI_WEBHOOK_SECRET;
    else process.env.ZAPI_WEBHOOK_SECRET = originalSecret;
  });

  it("toque em 'produto:{slug}' vira 'Quero ver o produto {slug}' e roteia ao bot ligado", async () => {
    // Modo fake: isWaEnabled/isBotEnabled não exigem credenciais no ambiente.
    vi.stubEnv("ADAPTER_MODE", "fake");
    await db.insert(schema.settings).values([
      { key: "wa_enabled", value: true },
      { key: "bot_enabled", value: true },
    ]);

    const result = await processZapiInbound(sdb, {
      providedSecret: SECRET,
      body: interactiveMessage("MSG-LIST-1", {
        listResponseMessage: {
          selectedRowId: "produto:camiseta-basica",
          title: "Camiseta Básica",
        },
      }),
    });

    expect(result.action).toBe("bot_queued");

    const messages = await db.select().from(schema.waMessages);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      direction: "inbound",
      zapiMessageId: "MSG-LIST-1",
      body: "Quero ver o produto camiseta-basica",
    });

    const outbox = await db.select().from(schema.outboxEvents);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      eventType: "wa.bot_turn",
      dedupeKey: "wa.bot_turn:MSG-LIST-1",
    });
  });

  it("toque em 'variante:{sku}' vira a escolha daquela combinação, com o SKU", async () => {
    const result = await processZapiInbound(sdb, {
      providedSecret: SECRET,
      body: interactiveMessage("MSG-LIST-VAR", {
        listResponseMessage: {
          selectedRowId: "variante:POLO-VD-P",
          title: "Verde · P",
        },
      }),
    });

    expect(result.action).toBe("forwarded");
    const messages = await db.select().from(schema.waMessages);
    expect(messages).toHaveLength(1);
    // O SKU exato é o que permite ao bot confirmar preço, estoque e pedido.
    expect(messages[0].body).toBe(
      "Escolhi esta opção: Verde · P (SKU POLO-VD-P). Confirme comigo essa combinação.",
    );
  });

  it("lista sem selectedRowId usa title; sem title usa message", async () => {
    const byTitle = await processZapiInbound(sdb, {
      providedSecret: SECRET,
      body: interactiveMessage("MSG-LIST-2", {
        listResponseMessage: { title: "Ver ofertas", message: "Menu" },
      }),
    });
    expect(byTitle.action).toBe("forwarded");

    const byMessage = await processZapiInbound(sdb, {
      providedSecret: SECRET,
      body: interactiveMessage("MSG-LIST-3", {
        listResponseMessage: { message: "Menu de opções" },
      }),
    });
    expect(byMessage.action).toBe("forwarded");

    const messages = await db.select().from(schema.waMessages);
    const bodies = new Map(messages.map((m) => [m.zapiMessageId, m.body]));
    expect(bodies.get("MSG-LIST-2")).toBe("Ver ofertas");
    expect(bodies.get("MSG-LIST-3")).toBe("Menu de opções");
  });

  it("buttonsResponseMessage.message vira o texto do inbound", async () => {
    const result = await processZapiInbound(sdb, {
      providedSecret: SECRET,
      body: interactiveMessage("MSG-BTN-1", {
        buttonsResponseMessage: { buttonId: "sim", message: "Sim, quero!" },
      }),
    });

    expect(result.action).toBe("forwarded");
    const messages = await db.select().from(schema.waMessages);
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toBe("Sim, quero!");
  });

  it("payload interativo duplicado (mesmo messageId) não duplica nada", async () => {
    const input = {
      providedSecret: SECRET,
      body: interactiveMessage("MSG-LIST-DUP", {
        listResponseMessage: {
          selectedRowId: "produto:camiseta-basica",
          title: "Camiseta Básica",
        },
      }),
    };

    const first = await processZapiInbound(sdb, input);
    const second = await processZapiInbound(sdb, input);

    expect(first.action).toBe("forwarded");
    expect(second).toEqual({ action: "duplicate", duplicate: true });

    expect(await db.select().from(schema.inboundEvents)).toHaveLength(1);
    expect(await db.select().from(schema.waMessages)).toHaveLength(1);
    expect(await db.select().from(schema.outboxEvents)).toHaveLength(1);
  });
});
