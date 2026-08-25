import { z } from "zod";

import type {
  MessagingProvider,
  OutboundTextMessage,
  QrCode,
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
export class ZapiMessagingProvider implements MessagingProvider {
  private readonly fetchFn: typeof fetch;

  constructor(fetchFn: typeof fetch = fetch) {
    this.fetchFn = fetchFn;
  }

  private async request(
    path: string,
    init?: { method?: "GET" | "POST"; body?: Record<string, unknown> },
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
        phone: message.toE164.replace(/^\+/, ""),
        message: message.body,
      },
    });

    const parsed = zapiSendTextResponseSchema.parse(raw);
    const providerMessageId = parsed.messageId ?? parsed.zaapId ?? parsed.id;
    if (!providerMessageId) {
      throw new Error("Resposta da Z-API sem id de mensagem em /send-text.");
    }
    return { providerMessageId };
  }

  async getSessionStatus(): Promise<SessionStatus> {
    const raw = await this.request("/status");
    const parsed = zapiStatusResponseSchema.parse(raw);
    return { connected: isConnectedPayload(parsed) };
  }

  async phoneExists(toE164: string): Promise<boolean> {
    // Fail-open: se a CONSULTA falhar (rede/HTTP), não bloqueamos um envio
    // legítimo — só a resposta explícita "exists: false" impede o envio.
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
