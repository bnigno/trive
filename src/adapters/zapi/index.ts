import { getAdapterMode } from "../adapter-mode";
import { ZapiMessagingProvider } from "./client";
import { FakeMessagingProvider } from "./fake";

export type OutboundTextMessage = {
  toE164: string;
  body: string;
  dedupeKey?: string;
};

export type SentMessage = {
  providerMessageId: string;
};

export type SessionStatus = {
  connected: boolean;
  qrCodeUrl?: string;
};

export interface MessagingProvider {
  sendText(message: OutboundTextMessage): Promise<SentMessage>;
  getSessionStatus(): Promise<SessionStatus>;
}

let instance: MessagingProvider | undefined;

export function getMessagingProvider(): MessagingProvider {
  if (!instance) {
    instance =
      getAdapterMode() === "real"
        ? new ZapiMessagingProvider()
        : new FakeMessagingProvider();
  }
  return instance;
}
