import { getAdapterMode } from "../adapter-mode";
import { ZapiMessagingProvider } from "./client";
import { FakeMessagingProvider } from "./fake";

export type OutboundTextMessage = {
  toE164: string;
  body: string;
};

export type SentMessage = {
  providerMessageId: string;
};

export type SessionStatus = {
  connected: boolean;
};

export type QrCode = {
  imageBase64: string;
};

/**
 * Contrato de mensageria WhatsApp. A Z-API é uma API NÃO-oficial (sessão de
 * WhatsApp Web): esta interface existe para trocarmos o adapter pela API
 * oficial (Cloud API) sem tocar nos serviços. Idempotência de envio fica no
 * serviço (wa_messages.dedupe_key), nunca no provider.
 */
export interface MessagingProvider {
  sendText(input: OutboundTextMessage): Promise<SentMessage>;
  getSessionStatus(): Promise<SessionStatus>;
  /** QR code de pareamento (png em base64) — null quando a sessão já está conectada. */
  getQrCode(): Promise<QrCode | null>;
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
