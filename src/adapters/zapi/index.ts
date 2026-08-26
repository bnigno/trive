import { getAdapterMode } from "../adapter-mode";
import { ZapiMessagingProvider } from "./client";
import { FakeMessagingProvider } from "./fake";

export type OutboundTextMessage = {
  toE164: string;
  body: string;
};

// Imagem é mensagem de MÍDIA da Z-API (endpoint /send-image, não /send-text).
export type OutboundImageMessage = {
  toE164: string;
  imageUrl: string;
  caption?: string;
};

export type OptionListOption = {
  id: string;
  title: string;
  description?: string;
};

// Lista de opções é mensagem de MÍDIA da Z-API e NÃO funciona em grupos.
export type OutboundOptionListMessage = {
  toE164: string;
  message: string;
  title: string;
  buttonLabel: string;
  options: OptionListOption[];
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
  /** Envia imagem por URL (mensagem de mídia da Z-API). */
  sendImage(input: OutboundImageMessage): Promise<SentMessage>;
  /** Envia lista interativa de opções (mídia da Z-API); não funciona em grupos. */
  sendOptionList(input: OutboundOptionListMessage): Promise<SentMessage>;
  getSessionStatus(): Promise<SessionStatus>;
  /** QR code de pareamento (png em base64) — null quando a sessão já está conectada. */
  getQrCode(): Promise<QrCode | null>;
  /**
   * O número TEM WhatsApp? A Z-API aceita envios para números inexistentes
   * em silêncio (caso real: pedido #1000) — o serviço consulta isto antes
   * de enviar. Indisponibilidade da consulta deve responder true (fail-open).
   */
  phoneExists(toE164: string): Promise<boolean>;
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
