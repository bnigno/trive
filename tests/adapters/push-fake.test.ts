import { describe, expect, it } from "vitest";

import { FakePushProvider } from "@/adapters/push/fake";

const payload = { title: "Nova mensagem de Ana", body: "oi", url: "/admin/whatsapp/conversas?c=1", tag: "wa:1" };

describe("FakePushProvider", () => {
  it("registra o envio; endpoint 'gone' morre (410); 'fail' é transitório", async () => {
    const provider = new FakePushProvider();
    expect(await provider.send({ subscription: { endpoint: "https://push.example/ok", p256dh: "k", auth: "a" }, payload, ttlSeconds: 60 })).toEqual({ ok: true });
    expect(provider.sent).toEqual([{ endpoint: "https://push.example/ok", payload, ttlSeconds: 60 }]);

    const gone = await provider.send({ subscription: { endpoint: "https://push.example/gone", p256dh: "k", auth: "a" }, payload, ttlSeconds: 60 });
    expect(gone).toMatchObject({ ok: false, gone: true, status: 410 });
    const fail = await provider.send({ subscription: { endpoint: "https://push.example/fail", p256dh: "k", auth: "a" }, payload, ttlSeconds: 60 });
    expect(fail).toMatchObject({ ok: false, gone: false, status: 503 });
    expect(provider.sent).toHaveLength(1);
    provider.reset();
    expect(provider.sent).toHaveLength(0);
  });
});
