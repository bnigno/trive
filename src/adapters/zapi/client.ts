import { z } from "zod";

import { isWaLid, waAddressForZapi } from "@/lib/phone";

import type {
  DownloadedMedia,
  MessagingProvider,
  OutboundAudioMessage,
  OutboundImageMessage,
  OutboundOptionListMessage,
  OutboundTextMessage,
  QrCode,
  RecentChat,
  SentMessage,
  SessionStatus,
} from "./index";

// ---------------------------------------------------------------------------
// Schemas TOLERANTES das respostas da Z-API: a API não-oficial varia os nomes
// de campo entre versões/endpoints, então aceitamos as variantes conhecidas e
// ignoramos o resto (loose). Nunca confiamos em mais do que o consumido aqui.
// ---------------------------------------------------------------------------

const idField = z
  .union([z.string(), z.number()])
  .transform((value) => String(value));

export const zapiSendTextResponseSchema = z.looseObject({
  messageId: idField.optional(),
  zaapId: idField.optional(),
  id: idField.optional(),
});

// GET /chats: lista com phone/name/lastMessageTime (ms em string) e isGroup.
// Um item fora do formato não derruba a lista: é só pulado.
const zapiChatsResponseSchema = z.array(
  z.looseObject({
    phone: z.union([z.string(), z.number()]).nullish(),
    name: z.string().nullish(),
    lastMessageTime: z.union([z.string(), z.number()]).nullish(),
    messageTime: z.union([z.string(), z.number()]).nullish(),
    isGroup: z.boolean().nullish(),
  }),
);

export const zapiStatusResponseSchema = z.looseObject({
  connected: z.union([z.boolean(), z.string()]).optional(),
  status: z.string().optional(),
});

export const zapiPhoneExistsResponseSchema = z.looseObject({
  exists: z.boolean().optional(),
});

export const zapiQrCodeResponseSchema = z.looseObject({
  value: z.string().optional(),
  image: z.string().optional(),
  qrcode: z.string().optional(),
  connected: z.union([z.boolean(), z.string()]).optional(),
});

function isConnectedPayload(payload: {
  connected?: boolean | string;
  status?: string;
}): boolean {
  if (payload.connected === true || payload.connected === "true") return true;
  return typeof payload.status === "string" && payload.status.toUpperCase() === "CONNECTED";
}

/** Remove prefixo de data URI ("data:image/png;base64,...") quando presente. */
function stripDataUriPrefix(value: string): string {
  return value.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
}

type ZapiCredentials = {
  instanceId: string;
  instanceToken: string;
  clientToken: string;
};

function getCredentials(): ZapiCredentials {
  const instanceId = process.env.ZAPI_INSTANCE_ID;
  const instanceToken = process.env.ZAPI_INSTANCE_TOKEN;
  const clientToken = process.env.ZAPI_CLIENT_TOKEN;
  if (!instanceId || !instanceToken || !clientToken) {
    throw new Error("Credenciais Z-API não configuradas");
  }
  return { instanceId, instanceToken, clientToken };
}

/**
 * Adapter REAL da Z-API (WhatsApp não-oficial) com fetch nativo.
 * Toda chamada leva o header 'Client-Token'. Erros HTTP expõem apenas o
 * status e o caminho do endpoint — NUNCA a URL completa (contém tokens).
 */
/** Marcar como lida é cosmético: não pode segurar o turno. */
const READ_TIMEOUT_MS = 3_000;

/** Atributos de "digitando"/entrega da Z-API para um envio com typingSeconds. */
function typingDelays(typingSeconds: number | undefined): Record<string, number> {
  if (typingSeconds === undefined) return {};
  return { delayTyping: Math.min(15, Math.max(1, Math.round(typingSeconds))), delayMessage: 1 };
}

export class ZapiMessagingProvider implements MessagingProvider {
  private readonly fetchFn: typeof fetch;

  constructor(fetchFn: typeof fetch = fetch) {
    this.fetchFn = fetchFn;
  }

  private async request(
    path: string,
    init?: { method?: "GET" | "POST"; body?: Record<string, unknown>; signal?: AbortSignal },
  ): Promise<unknown> {
    const { instanceId, instanceToken, clientToken } = getCredentials();
    const url = `https://api.z-api.io/instances/${instanceId}/token/${instanceToken}${path}`;

    const response = await this.fetchFn(url, {
      method: init?.method ?? "GET",
      headers: {
        "Client-Token": clientToken,
        ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      ...(init?.signal ? { signal: init.signal } : {}),
    });

    if (response.status >= 400) {
      throw new Error(`Z-API respondeu HTTP ${response.status} em ${path}.`);
    }

    try {
      return (await response.json()) as unknown;
    } catch {
      return {};
    }
  }

  async sendText(message: OutboundTextMessage): Promise<SentMessage> {
    const raw = await this.request("/send-text", {
      method: "POST",
      body: {
        // Z-API espera o número SEM o '+' do E.164.
        phone: waAddressForZapi(message.toE164),
        message: message.body,
        // delayTyping = segundos de "digitando…" antes da entrega; com ele,
        // delayMessage fixo no mínimo (1 s) em vez do padrão aleatório de
        // 1–3 s que a Z-API aplica quando não se diz nada.
        ...typingDelays(message.typingSeconds),
      },
    });

    const parsed = zapiSendTextResponseSchema.parse(raw);
    const providerMessageId = parsed.messageId ?? parsed.zaapId ?? parsed.id;
    if (!providerMessageId) {
      throw new Error("Resposta da Z-API sem id de mensagem em /send-text.");
    }
    return { providerMessageId };
  }

  async sendImage(message: OutboundImageMessage): Promise<SentMessage> {
    const raw = await this.request("/send-image", {
      method: "POST",
      body: {
        // Z-API espera o número SEM o '+' do E.164.
        phone: waAddressForZapi(message.toE164),
        image: message.imageUrl,
        ...(message.caption !== undefined ? { caption: message.caption } : {}),
      },
    });

    const parsed = zapiSendTextResponseSchema.parse(raw);
    const providerMessageId = parsed.messageId ?? parsed.zaapId ?? parsed.id;
    if (!providerMessageId) {
      throw new Error("Resposta da Z-API sem id de mensagem em /send-image.");
    }
    return { providerMessageId };
  }

  async sendAudio(message: OutboundAudioMessage): Promise<SentMessage> {
    // Z-API: { phone (sem '+'), audio: URL ou base64, waveform } → sai como
    // mensagem de voz; a resposta traz zaapId/messageId/id como o texto.
    const raw = await this.request("/send-audio", {
      method: "POST",
      body: {
        phone: waAddressForZapi(message.toE164),
        audio: message.audioUrl,
        waveform: true,
        // Aqui o status é "gravando áudio…".
        ...typingDelays(message.typingSeconds),
      },
    });

    const parsed = zapiSendTextResponseSchema.parse(raw);
    const providerMessageId = parsed.messageId ?? parsed.zaapId ?? parsed.id;
    if (!providerMessageId) {
      throw new Error("Resposta da Z-API sem id de mensagem em /send-audio.");
    }
    return { providerMessageId };
  }

  async sendOptionList(message: OutboundOptionListMessage): Promise<SentMessage> {
    const raw = await this.request("/send-option-list", {
      method: "POST",
      body: {
        // Z-API espera o número SEM o '+' do E.164.
        phone: waAddressForZapi(message.toE164),
        message: message.message,
        // A lista não tem "digitando"; só tira o atraso aleatório de 1–3 s.
        delayMessage: 1,
        optionList: {
          title: message.title,
          buttonLabel: message.buttonLabel,
          options: message.options.map((option) => ({
            id: option.id,
            title: option.title,
            ...(option.description !== undefined
              ? { description: option.description }
              : {}),
          })),
        },
      },
    });

    const parsed = zapiSendTextResponseSchema.parse(raw);
    const providerMessageId = parsed.messageId ?? parsed.zaapId ?? parsed.id;
    if (!providerMessageId) {
      throw new Error("Resposta da Z-API sem id de mensagem em /send-option-list.");
    }
    return { providerMessageId };
  }

  async listRecentChats(limit: number): Promise<RecentChat[]> {
    const raw = await this.request(`/chats?page=1&pageSize=${Math.max(1, Math.min(limit, 100))}`);
    const parsed = zapiChatsResponseSchema.parse(raw);
    const chats: RecentChat[] = [];
    for (const chat of parsed) {
      const phone = chat.phone != null ? String(chat.phone).trim() : "";
      const ms = Number(chat.lastMessageTime ?? chat.messageTime ?? NaN);
      if (!phone || !Number.isFinite(ms) || ms <= 0) continue;
      chats.push({
        phone,
        name: chat.name?.trim() || null,
        lastMessageAt: new Date(ms),
        isGroup: chat.isGroup === true || phone.includes("-group") || phone.endsWith("@g.us"),
      });
    }
    return chats;
  }

  async getSessionStatus(): Promise<SessionStatus> {
    const raw = await this.request("/status");
    const parsed = zapiStatusResponseSchema.parse(raw);
    return { connected: isConnectedPayload(parsed) };
  }

  async markAsRead(input: { fromE164: string; providerMessageId: string }): Promise<void> {
    // POST /read-message { phone, messageId } — ✓✓ azul na mensagem dela.
    await this.request("/read-message", {
      method: "POST",
      body: { phone: waAddressForZapi(input.fromE164), messageId: input.providerMessageId },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  }

  async phoneExists(toE164: string): Promise<boolean> {
    // Fail-open: se a CONSULTA falhar (rede/HTTP), não bloqueamos um envio
    // legítimo — só a resposta explícita "exists: false" impede o envio.
    // LID (número oculto) não tem consulta: quem mandou a mensagem existe.
    if (isWaLid(toE164)) return true;
    try {
      const raw = await this.request(
        `/phone-exists/${toE164.replace(/^\+/, "")}`,
      );
      const parsed = zapiPhoneExistsResponseSchema.parse(raw);
      return parsed.exists !== false;
    } catch {
      return true;
    }
  }

  async downloadMedia(input: { url: string; maxBytes: number }): Promise<DownloadedMedia> {
    // URL pública do storage da Z-API: sem Client-Token. Nunca logamos a URL
    // inteira (pode carregar identificadores da instância).
    let response: Response;
    try {
      response = await this.fetchFn(input.url, {
        method: "GET",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error("Mídia da Z-API indisponível (rede ou tempo esgotado).");
    }
    if (response.status >= 400) {
      throw new Error(`Mídia da Z-API indisponível (HTTP ${response.status}).`);
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > input.maxBytes) {
      throw new Error("Mídia da Z-API maior que o limite aceito.");
    }
    const data = Buffer.from(await response.arrayBuffer());
    if (data.byteLength > input.maxBytes) {
      throw new Error("Mídia da Z-API maior que o limite aceito.");
    }
    return { data, contentType: response.headers.get("content-type") };
  }

  async getQrCode(): Promise<QrCode | null> {
    const raw = await this.request("/qr-code/image");
    const parsed = zapiQrCodeResponseSchema.parse(raw);

    // Sessão já conectada não tem QR code para parear.
    if (isConnectedPayload({ connected: parsed.connected })) return null;

    const value = parsed.value ?? parsed.image ?? parsed.qrcode;
    if (!value) return null;
    return { imageBase64: stripDataUriPrefix(value) };
  }
}
