import { z } from "zod";

import { isWaLid, toWaGroupId, toWaLid, waAddressForZapi } from "@/lib/phone";

import type {
  DownloadedMedia,
  GroupMetadata,
  GroupParticipant,
  GroupSettings,
  GroupSummary,
  MessagingProvider,
  OutboundAudioMessage,
  OutboundImageMessage,
  OutboundOptionListMessage,
  OutboundPollMessage,
  OutboundReaction,
  OutboundTextMessage,
  PinDuration,
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
    lid: z.string().nullish(),
    name: z.string().nullish(),
    lastMessageTime: z.union([z.string(), z.number()]).nullish(),
    messageTime: z.union([z.string(), z.number()]).nullish(),
    unread: z.union([z.string(), z.number()]).nullish(),
    messagesUnread: z.union([z.string(), z.number()]).nullish(),
    isGroup: z.boolean().nullish(),
  }),
);

// GET /groups: mesmo formato do /chats, só grupos.
const zapiGroupsResponseSchema = z.array(
  z.looseObject({
    phone: z.union([z.string(), z.number()]).nullish(),
    name: z.string().nullish(),
    isGroup: z.boolean().nullish(),
  }),
);

// GET /group-metadata/{id}: participantes vêm com `phone` — que em produção
// pode ser um LID ('…@lid') quando o WhatsApp esconde o número.
const zapiGroupParticipantSchema = z.looseObject({
  phone: z.union([z.string(), z.number()]).nullish(),
  lid: z.string().nullish(),
  isAdmin: z.boolean().nullish(),
  isSuperAdmin: z.boolean().nullish(),
});

export const zapiGroupMetadataResponseSchema = z.looseObject({
  phone: z.union([z.string(), z.number()]).nullish(),
  subject: z.string().nullish(),
  description: z.string().nullish(),
  owner: z.union([z.string(), z.number()]).nullish(),
  invitationLink: z.string().nullish(),
  adminOnlyMessage: z.boolean().nullish(),
  adminOnlySettings: z.boolean().nullish(),
  requireAdminApproval: z.boolean().nullish(),
  participants: z.array(zapiGroupParticipantSchema).nullish(),
});

export const zapiInvitationLinkResponseSchema = z.looseObject({
  invitationLink: z.string().nullish(),
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

/** Telefone como a Z-API entrega ('5591…', com ou sem '+', ou LID) → E.164; null para LID/vazio. */
function zapiPhoneToE164(raw: string | number | null | undefined): string | null {
  if (raw == null) return null;
  const value = String(raw).trim();
  if (!value || toWaLid(value)) return null;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 8 ? `+${digits}` : null;
}

function parseGroupParticipant(raw: z.infer<typeof zapiGroupParticipantSchema>): GroupParticipant | null {
  const phoneRaw = raw.phone != null ? String(raw.phone) : null;
  const lid = toWaLid(raw.lid) ?? toWaLid(phoneRaw);
  const phoneE164 = zapiPhoneToE164(phoneRaw);
  if (!phoneE164 && !lid) return null;
  return {
    phoneE164,
    lid,
    isAdmin: raw.isAdmin === true || raw.isSuperAdmin === true,
  };
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
        // messageId no /send-text = "responder mensagem" (balão citado).
        ...(message.quotedProviderMessageId !== undefined
          ? { messageId: message.quotedProviderMessageId }
          : {}),
        // Menção em grupo: a Z-API liga cada '@número' do texto ao participante.
        ...(message.mentionedPhones !== undefined && message.mentionedPhones.length > 0
          ? { mentioned: message.mentionedPhones.map((phone) => phone.replace(/^\+/, "")) }
          : {}),
      },
    });

    const parsed = zapiSendTextResponseSchema.parse(raw);
    const providerMessageId = parsed.messageId ?? parsed.zaapId ?? parsed.id;
    if (!providerMessageId) {
      throw new Error("Resposta da Z-API sem id de mensagem em /send-text.");
    }
    return { providerMessageId };
  }

  async sendPoll(message: OutboundPollMessage): Promise<SentMessage> {
    const raw = await this.request("/send-poll", {
      method: "POST",
      body: {
        phone: waAddressForZapi(message.toGroupId),
        message: message.question,
        poll: message.options.map((name) => ({ name })),
        pollMaxOptions: message.maxOptions ?? 1,
        delayMessage: 1,
      },
    });

    const parsed = zapiSendTextResponseSchema.parse(raw);
    const providerMessageId = parsed.messageId ?? parsed.zaapId ?? parsed.id;
    if (!providerMessageId) {
      throw new Error("Resposta da Z-API sem id de mensagem em /send-poll.");
    }
    return { providerMessageId };
  }

  async sendReaction(input: OutboundReaction): Promise<void> {
    await this.request("/send-reaction", {
      method: "POST",
      body: {
        phone: waAddressForZapi(input.to),
        reaction: input.emoji,
        messageId: input.providerMessageId,
      },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  }

  async pinMessage(input: { to: string; providerMessageId: string; duration: PinDuration }): Promise<void> {
    await this.request("/pin-message", {
      method: "POST",
      body: {
        phone: waAddressForZapi(input.to),
        messageId: input.providerMessageId,
        messageAction: "pin",
        pinMessageDuration: input.duration,
      },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  }

  async listGroups(): Promise<GroupSummary[]> {
    const raw = await this.request("/groups");
    const parsed = zapiGroupsResponseSchema.parse(raw);
    const groups: GroupSummary[] = [];
    for (const item of parsed) {
      const groupId = toWaGroupId(item.phone != null ? String(item.phone) : null);
      if (!groupId) continue;
      groups.push({ groupId, name: item.name?.trim() || null });
    }
    return groups;
  }

  async getGroupMetadata(groupId: string): Promise<GroupMetadata> {
    const raw = await this.request(`/group-metadata/${encodeURIComponent(groupId)}`);
    const parsed = zapiGroupMetadataResponseSchema.parse(raw);
    const participants: GroupParticipant[] = [];
    for (const item of parsed.participants ?? []) {
      const participant = parseGroupParticipant(item);
      if (participant) participants.push(participant);
    }
    return {
      groupId: toWaGroupId(parsed.phone != null ? String(parsed.phone) : null) ?? groupId,
      name: parsed.subject?.trim() || null,
      description: parsed.description?.trim() || null,
      ownerE164: zapiPhoneToE164(parsed.owner),
      invitationLink: parsed.invitationLink?.trim() || null,
      adminOnlyMessage: parsed.adminOnlyMessage === true,
      adminOnlySettings: parsed.adminOnlySettings === true,
      requireAdminApproval: parsed.requireAdminApproval === true,
      participants,
    };
  }

  async getGroupInvitationLink(groupId: string): Promise<string | null> {
    const raw = await this.request(`/group-invitation-link/${encodeURIComponent(groupId)}`);
    const parsed = zapiInvitationLinkResponseSchema.parse(raw);
    return parsed.invitationLink?.trim() || null;
  }

  async updateGroupSettings(groupId: string, settings: GroupSettings): Promise<void> {
    await this.request("/update-group-settings", {
      method: "POST",
      body: {
        phone: waAddressForZapi(groupId),
        adminOnlyMessage: settings.adminOnlyMessage,
        adminOnlySettings: settings.adminOnlySettings,
        requireAdminApproval: settings.requireAdminApproval,
        adminOnlyAddMember: settings.adminOnlyAddMember,
      },
    });
  }

  async removeGroupParticipants(groupId: string, phonesE164: string[]): Promise<void> {
    if (phonesE164.length === 0) return;
    await this.request("/remove-participant", {
      method: "POST",
      body: {
        groupId: waAddressForZapi(groupId),
        phones: phonesE164.map((phone) => waAddressForZapi(phone)),
      },
    });
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
      // Em produção vem em milissegundos (13 dígitos); a doc mostra segundos
      // (10 dígitos) — aceitamos os dois.
      const raw = Number(chat.lastMessageTime ?? chat.messageTime ?? NaN);
      const ms = raw < 1e11 ? raw * 1000 : raw;
      if (!phone || !Number.isFinite(ms) || ms <= 0) continue;
      const unread = Number(chat.unread ?? chat.messagesUnread ?? 0);
      chats.push({
        phone,
        lid: chat.lid?.trim() || null,
        name: chat.name?.trim() || null,
        lastMessageAt: new Date(ms),
        unread: Number.isFinite(unread) && unread > 0 ? Math.floor(unread) : 0,
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
