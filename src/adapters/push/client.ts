// `web-push`: assina com VAPID e cifra o payload (RFC 8291) para o endpoint
// da Apple/Google/Mozilla. As chaves vêm do ambiente; o subject é o contato
// que os servidores de push podem procurar (mailto: ou a URL da loja).
import webpush, { WebPushError } from "web-push";

import type { PushProvider, PushSendResult, PushSubscriptionKeys } from "./index";
import type { PushPayload } from "@/core/notify/push";

let vapidReady = false;

function ensureVapid(): void {
  if (vapidReady) return;
  const subject = process.env.WEB_PUSH_SUBJECT?.trim();
  const publicKey = process.env.WEB_PUSH_VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.WEB_PUSH_VAPID_PRIVATE_KEY?.trim();
  if (!subject || !publicKey || !privateKey) {
    throw new Error("Web Push sem chaves: defina WEB_PUSH_SUBJECT, WEB_PUSH_VAPID_PUBLIC_KEY e WEB_PUSH_VAPID_PRIVATE_KEY.");
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  vapidReady = true;
}

export class WebPushClient implements PushProvider {
  async send(input: { subscription: PushSubscriptionKeys; payload: PushPayload; ttlSeconds: number }): Promise<PushSendResult> {
    ensureVapid();
    try {
      await webpush.sendNotification(
        { endpoint: input.subscription.endpoint, keys: { p256dh: input.subscription.p256dh, auth: input.subscription.auth } },
        JSON.stringify(input.payload),
        { TTL: input.ttlSeconds, urgency: "high" },
      );
      return { ok: true };
    } catch (error) {
      if (error instanceof WebPushError) {
        return { ok: false, gone: error.statusCode === 404 || error.statusCode === 410, status: error.statusCode, error: `HTTP ${error.statusCode}: ${error.body?.slice(0, 200) ?? error.message}` };
      }
      return { ok: false, gone: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
