// Web Push atrás de interface própria: o painel instalado no celular (ou o
// Chrome do Mac) recebe o aviso mesmo fechado. Real = `web-push` (VAPID);
// fake = registra o envio. Seleção por ADAPTER_MODE, como os outros.
import type { PushPayload } from "@/core/notify/push";

import { getAdapterMode } from "../adapter-mode";
import { WebPushClient } from "./client";
import { FakePushProvider } from "./fake";

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type PushSendResult =
  | { ok: true }
  | {
      ok: false;
      /** 404/410: a inscrição morreu (app desinstalado, permissão revogada, expirou) — apagar, não tentar de novo. */
      gone: boolean;
      status?: number;
      error: string;
    };

export interface PushProvider {
  send(input: { subscription: PushSubscriptionKeys; payload: PushPayload; ttlSeconds: number }): Promise<PushSendResult>;
}

export function pushVapidPublicKey(): string | null {
  const key = process.env.WEB_PUSH_VAPID_PUBLIC_KEY?.trim();
  return key ? key : null;
}

/** Há como mandar push neste ambiente? (fake: sempre; real: com as 3 chaves VAPID). */
export function isPushConfigured(): boolean {
  if (getAdapterMode() !== "real") return true;
  return [process.env.WEB_PUSH_VAPID_PUBLIC_KEY, process.env.WEB_PUSH_VAPID_PRIVATE_KEY, process.env.WEB_PUSH_SUBJECT].every(
    (value) => typeof value === "string" && value.trim() !== "",
  );
}

let instance: PushProvider | undefined;

export function getPushProvider(): PushProvider {
  if (!instance) {
    instance = getAdapterMode() === "real" ? new WebPushClient() : new FakePushProvider();
  }
  return instance;
}
