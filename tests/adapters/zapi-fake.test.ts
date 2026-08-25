import { describe, expect, it } from "vitest";

import type { MessagingProvider } from "@/adapters/zapi";
import { getMessagingProvider } from "@/adapters/zapi";
import {
  FAKE_QR_CODE_PNG_BASE64,
  FakeMessagingProvider,
} from "@/adapters/zapi/fake";

describe("FakeMessagingProvider (contrato MessagingProvider)", () => {
  it("implementa a interface completa do contrato", () => {
    const provider: MessagingProvider = new FakeMessagingProvider();
    expect(provider.sendText).toBeTypeOf("function");
    expect(provider.getSessionStatus).toBeTypeOf("function");
    expect(provider.getQrCode).toBeTypeOf("function");
  });

  it("getMessagingProvider devolve o fake quando ADAPTER_MODE não é 'real'", () => {
    expect(process.env.ADAPTER_MODE).not.toBe("real");
    expect(getMessagingProvider()).toBeInstanceOf(FakeMessagingProvider);
  });

  it("sendText registra {toE164, body} inspecionáveis e retorna providerMessageId", async () => {
    const provider = new FakeMessagingProvider();
    const first = await provider.sendText({
      toE164: "+5511999990000",
      body: "Seu pedido foi confirmado!",
    });
    const second = await provider.sendText({
      toE164: "+5511888880000",
      body: "Pedido enviado!",
    });

    expect(first.providerMessageId).toBe("fake-zapi-msg-1");
    expect(second.providerMessageId).toBe("fake-zapi-msg-2");
    expect(provider.sentMessages).toHaveLength(2);
    expect(provider.sentMessages[0]).toMatchObject({
      toE164: "+5511999990000",
      body: "Seu pedido foi confirmado!",
    });
    expect(provider.sentMessages[1]).toMatchObject({
      toE164: "+5511888880000",
      body: "Pedido enviado!",
    });
  });

  it("conectado: status {connected: true} e getQrCode null", async () => {
    const provider = new FakeMessagingProvider();
    await expect(provider.getSessionStatus()).resolves.toEqual({ connected: true });
    await expect(provider.getQrCode()).resolves.toBeNull();
  });

  it("desconectado: sendText lança, status false e getQrCode devolve png base64", async () => {
    const provider = new FakeMessagingProvider();
    provider.simulateDisconnect();

    await expect(
      provider.sendText({ toE164: "+5511999990000", body: "Oi" }),
    ).rejects.toThrow(/desconectada/);
    await expect(provider.getSessionStatus()).resolves.toEqual({ connected: false });

    const qr = await provider.getQrCode();
    expect(qr).not.toBeNull();
    expect(qr?.imageBase64).toBe(FAKE_QR_CODE_PNG_BASE64);
    // Base64 válido de um PNG: a assinatura decodificada começa com \x89PNG.
    const decoded = Buffer.from(qr?.imageBase64 ?? "", "base64");
    expect(decoded.subarray(1, 4).toString("ascii")).toBe("PNG");
  });

  it("simulateReconnect restaura envio e esconde o QR code", async () => {
    const provider = new FakeMessagingProvider();
    provider.simulateDisconnect();
    provider.simulateReconnect();

    await expect(
      provider.sendText({ toE164: "+5511999990000", body: "Oi de novo" }),
    ).resolves.toHaveProperty("providerMessageId");
    await expect(provider.getQrCode()).resolves.toBeNull();
  });

  it("reset limpa mensagens, sequência e reconecta", async () => {
    const provider = new FakeMessagingProvider();
    await provider.sendText({ toE164: "+5511999990000", body: "Oi" });
    provider.simulateDisconnect();

    provider.reset();

    expect(provider.sentMessages).toHaveLength(0);
    await expect(provider.getSessionStatus()).resolves.toEqual({ connected: true });
    const sent = await provider.sendText({ toE164: "+5511999990000", body: "De novo" });
    expect(sent.providerMessageId).toBe("fake-zapi-msg-1");
  });
});
