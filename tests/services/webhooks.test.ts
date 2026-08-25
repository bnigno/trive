import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { processInboundMpWebhook } from "@/services/webhooks";
import { createTestDb, type TestDb } from "../helpers/db";

const SECRET = "segredo-webhook-mp";

function signedHeaders(dataId: string, requestId = "req-1") {
  const ts = String(Math.floor(Date.now() / 1000));
  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const v1 = createHmac("sha256", SECRET).update(manifest).digest("hex");
  return { xSignature: `ts=${ts},v1=${v1}`, xRequestId: requestId };
}

function paymentBody(dataId: string) {
  return {
    type: "payment",
    action: "payment.updated",
    data: { id: dataId },
  };
}

describe("processInboundMpWebhook", () => {
  let db: TestDb;
  let sdb: DbOrTx;
  let close: () => Promise<void>;
  const originalSecret = process.env.MP_WEBHOOK_SECRET;

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    sdb = db as unknown as DbOrTx;
    process.env.MP_WEBHOOK_SECRET = SECRET;
  });

  afterEach(async () => {
    await close();
    if (originalSecret === undefined) delete process.env.MP_WEBHOOK_SECRET;
    else process.env.MP_WEBHOOK_SECRET = originalSecret;
    vi.restoreAllMocks();
  });

  it("assinatura válida: grava inbound done e enfileira mp.payment_event na mesma transação", async () => {
    const result = await processInboundMpWebhook(sdb, {
      ...signedHeaders("111"),
      body: paymentBody("111"),
      rawDataId: "111",
    });

    expect(result).toEqual({
      duplicate: false,
      enqueued: true,
      signatureValid: true,
    });

    const inbound = await db.select().from(schema.inboundEvents);
    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toMatchObject({
      source: "mercadopago",
      externalEventId: expect.stringMatching(/^payment:111:/),
      eventType: "payment",
      signatureValid: true,
      status: "done",
    });
    expect(inbound[0].processedAt).not.toBeNull();

    const outbox = await db.select().from(schema.outboxEvents);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      eventType: "mp.payment_event",
      dedupeKey: expect.stringMatching(/^mp\.payment_event:/),
      payload: { mpPaymentId: "111" },
    });
  });

  it("duplicata: segundo webhook igual retorna duplicate true e não reenfileira", async () => {
    const input = {
      ...signedHeaders("222"),
      body: paymentBody("222"),
      rawDataId: "222",
    };
    const first = await processInboundMpWebhook(sdb, input);
    const second = await processInboundMpWebhook(sdb, input);

    expect(first.duplicate).toBe(false);
    expect(second).toMatchObject({ duplicate: true, enqueued: false });

    expect(await db.select().from(schema.inboundEvents)).toHaveLength(1);
    expect(await db.select().from(schema.outboxEvents)).toHaveLength(1);
  });

  it("assinatura inválida: grava inbound ignored com signatureValid false e não enfileira", async () => {
    const result = await processInboundMpWebhook(sdb, {
      xSignature: "ts=1700000000,v1=deadbeef",
      xRequestId: "req-x",
      body: paymentBody("333"),
      rawDataId: "333",
    });

    expect(result).toEqual({
      duplicate: false,
      enqueued: false,
      signatureValid: false,
    });

    const inbound = await db.select().from(schema.inboundEvents);
    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toMatchObject({
      signatureValid: false,
      status: "ignored",
    });
    expect(await db.select().from(schema.outboxEvents)).toHaveLength(0);
  });

  it("assinatura malformada conta como inválida", async () => {
    const result = await processInboundMpWebhook(sdb, {
      xSignature: "isso-nao-e-uma-assinatura",
      xRequestId: "req-y",
      body: paymentBody("444"),
      rawDataId: "444",
    });

    expect(result.signatureValid).toBe(false);
    expect(result.enqueued).toBe(false);
  });

  it("sem MP_WEBHOOK_SECRET: aceita com warn e signatureValid null", async () => {
    delete process.env.MP_WEBHOOK_SECRET;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await processInboundMpWebhook(sdb, {
      xSignature: null,
      xRequestId: "req-z",
      body: paymentBody("555"),
      rawDataId: "555",
    });

    expect(result).toEqual({
      duplicate: false,
      enqueued: true,
      signatureValid: null,
    });
    expect(warn).toHaveBeenCalled();

    const inbound = await db.select().from(schema.inboundEvents);
    expect(inbound[0]).toMatchObject({ signatureValid: null, status: "done" });
    expect(await db.select().from(schema.outboxEvents)).toHaveLength(1);
  });

  it("topic não-payment: grava ignored e não enfileira", async () => {
    const result = await processInboundMpWebhook(sdb, {
      ...signedHeaders("666"),
      body: { type: "merchant_order", data: { id: "666" } },
      rawDataId: "666",
    });

    expect(result).toMatchObject({ duplicate: false, enqueued: false });

    const inbound = await db.select().from(schema.inboundEvents);
    expect(inbound[0]).toMatchObject({
      externalEventId: expect.stringMatching(/^merchant_order:666/),
      status: "ignored",
    });
    expect(await db.select().from(schema.outboxEvents)).toHaveLength(0);
  });

  it("formato query (rawDataId + topic no body IPN) enfileira normalmente", async () => {
    delete process.env.MP_WEBHOOK_SECRET;
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await processInboundMpWebhook(sdb, {
      xSignature: null,
      xRequestId: "req-ipn",
      body: { topic: "payment" },
      rawDataId: "777",
    });

    expect(result.enqueued).toBe(true);
    const outbox = await db.select().from(schema.outboxEvents);
    expect(outbox[0]).toMatchObject({
      dedupeKey: expect.stringMatching(/^mp\.payment_event:/),
      payload: { mpPaymentId: "777" },
    });
  });

  it("notificações DIFERENTES do mesmo pagamento (Pix criado → pago) são AMBAS processadas", async () => {
    // Regressão do pedido #1000: o MP envia vários webhooks para o mesmo
    // payment id; deduplicar por payment id engolia o aviso de pagamento.
    const first = await processInboundMpWebhook(sdb, {
      ...signedHeaders("999"),
      body: { ...paymentBody("999"), id: "notif-1" },
      rawDataId: "999",
    });
    const second = await processInboundMpWebhook(sdb, {
      ...signedHeaders("999"),
      body: { ...paymentBody("999"), id: "notif-2" },
      rawDataId: "999",
    });
    expect(first).toMatchObject({ duplicate: false, enqueued: true });
    expect(second).toMatchObject({ duplicate: false, enqueued: true });
    const outbox = await db.select().from(schema.outboxEvents);
    expect(outbox).toHaveLength(2);
  });

  it("payment sem dataId nenhum: ignored, externalEventId cai no x-request-id", async () => {
    const result = await processInboundMpWebhook(sdb, {
      ...signedHeaders("888", "req-sem-id"),
      body: { type: "payment" },
    });

    expect(result.enqueued).toBe(false);
    const inbound = await db.select().from(schema.inboundEvents);
    expect(inbound[0]).toMatchObject({
      externalEventId: "req-sem-id",
      status: "ignored",
    });
  });

  it("body não-objeto não quebra (Zod tolerante)", async () => {
    delete process.env.MP_WEBHOOK_SECRET;
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await processInboundMpWebhook(sdb, {
      xSignature: null,
      xRequestId: "req-lixo",
      body: "lixo qualquer",
    });

    expect(result).toMatchObject({ duplicate: false, enqueued: false });
    expect(await db.select().from(schema.inboundEvents)).toHaveLength(1);
  });
});
