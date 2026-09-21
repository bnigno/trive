// Push de mentira para dev e testes: guarda o que mandaria. Endpoint com
// "gone" simula inscrição morta (410); com "fail", falha transitória.
import type { PushProvider, PushSendResult, PushSubscriptionKeys } from "./index";
import type { PushPayload } from "@/core/notify/push";

export class FakePushProvider implements PushProvider {
  readonly sent: Array<{ endpoint: string; payload: PushPayload; ttlSeconds: number }> = [];

  async send(input: { subscription: PushSubscriptionKeys; payload: PushPayload; ttlSeconds: number }): Promise<PushSendResult> {
    if (input.subscription.endpoint.includes("gone")) return { ok: false, gone: true, status: 410, error: "HTTP 410: inscrição expirada (fake)" };
    if (input.subscription.endpoint.includes("fail")) return { ok: false, gone: false, status: 503, error: "HTTP 503: servidor de push fora do ar (fake)" };
    this.sent.push({ endpoint: input.subscription.endpoint, payload: input.payload, ttlSeconds: input.ttlSeconds });
    return { ok: true };
  }

  reset(): void {
    this.sent.length = 0;
  }
}
