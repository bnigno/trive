// Web Push (aviso no celular com o painel fechado): a chave de cadência e o texto.
import { describe, expect, it } from "vitest";

import {
  PUSH_BUCKET_MS,
  pushDedupeKey,
  pushNewMessagePayloadSchema,
  pushPayloadFor,
  pushPayloadSchema,
} from "@/core/notify/push";

const CONV = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("pushDedupeKey", () => {
  it("uma chave por conversa a cada 2 minutos: 30 s depois é a mesma, 2 min depois é outra; ler a conversa no meio muda a chave", () => {
    const t0 = new Date("2026-09-21T12:00:00.000Z");
    const key = pushDedupeKey(CONV, t0, null);
    expect(key).toMatch(new RegExp(`^push\\.new_message:${CONV}:\\d+:0$`));
    expect(pushDedupeKey(CONV, new Date(t0.getTime() + 30_000), null)).toBe(key);
    expect(pushDedupeKey(CONV, new Date(t0.getTime() + PUSH_BUCKET_MS), null)).not.toBe(key);
    expect(pushDedupeKey("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", t0, null)).not.toBe(key);
    // O dono leu aos 30 s: a resposta aos 60 s (mesma janela) merece aviso de novo.
    const seen = new Date(t0.getTime() + 30_000);
    expect(pushDedupeKey(CONV, new Date(t0.getTime() + 60_000), seen)).not.toBe(key);
    expect(pushDedupeKey(CONV, new Date(t0.getTime() + 90_000), seen)).toBe(pushDedupeKey(CONV, new Date(t0.getTime() + 60_000), seen));
  });
});

describe("pushPayloadFor", () => {
  it("mesmo texto do toast: 'esperando por você' quando é com o dono, 'Nova mensagem' com a vendedora; abre a conversa", () => {
    expect(pushPayloadFor({ conversationId: CONV, label: "Ana", preview: "tem em M?", awaitingOwner: false })).toEqual({
      title: "Nova mensagem de Ana",
      body: "tem em M?",
      url: `/admin/whatsapp/conversas?c=${CONV}`,
      // O mesmo tag do aviso da aba (use-notify): um substitui o outro no aparelho.
      tag: CONV,
    });
    const awaiting = pushPayloadFor({ conversationId: CONV, label: "Ana", preview: null, awaitingOwner: true });
    expect(awaiting.title).toBe("Ana está esperando por você");
    expect(awaiting.body).toBeNull();
    expect(pushPayloadSchema.safeParse(awaiting).success).toBe(true);
  });

  it("a fila só carrega ids válidos", () => {
    expect(pushNewMessagePayloadSchema.safeParse({ conversationId: CONV, waMessageId: CONV }).success).toBe(true);
    expect(pushNewMessagePayloadSchema.safeParse({ conversationId: "x", waMessageId: CONV }).success).toBe(false);
    expect(pushNewMessagePayloadSchema.safeParse({ conversationId: CONV }).success).toBe(false);
  });
});
