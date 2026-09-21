import { getAdapterMode } from "../adapter-mode";
import { ZapiMessagingProvider } from "./client";
import { FakeMessagingProvider } from "./fake";

export type OutboundTextMessage = {
  /** Endereço: E.164 ('+5591…'), LID ('…@lid') ou id de grupo ('…-group'). */
  toE164: string;
  body: string;
  /** Segundos de "digitando…" antes de a mensagem aparecer (1–15). */
  typingSeconds?: number;
  /** Responde citando esta mensagem (o balão aparece "em resposta a"). */
  quotedProviderMessageId?: string;
  /**
   * Menciona participantes (só em grupo): telefones SEM '+', e o texto
   * precisa trazer '@' + o mesmo número em cada menção.
   */
  mentionedPhones?: string[];
};

// Imagem é mensagem de MÍDIA da Z-API (endpoint /send-image, não /send-text).
export type OutboundImageMessage = {
  toE164: string;
  imageUrl: string;
  caption?: string;
};

/** Áudio por URL pública: o WhatsApp mostra como mensagem de voz (PTT). */
export type OutboundAudioMessage = {
  toE164: string;
  audioUrl: string;
  /** Segundos de "gravando áudio…" antes de a mensagem aparecer (1–15). */
  typingSeconds?: number;
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

/** Enquete nativa do WhatsApp — a Z-API só a envia para GRUPOS. */
export type OutboundPollMessage = {
  toGroupId: string;
  question: string;
  /** 2 a 12 opções, como o WhatsApp permite. */
  options: string[];
  /** Quantas opções cada pessoa pode marcar (padrão: 1). */
  maxOptions?: number;
};

export type OutboundReaction = {
  /** Endereço do chat (E.164, LID ou grupo) onde a mensagem está. */
  to: string;
  providerMessageId: string;
  /** Um emoji; string vazia remove a reação. */
  emoji: string;
};

export type PinDuration = "24_hours" | "7_days" | "30_days";

export type SentMessage = {
  providerMessageId: string;
};

/** Um participante como o metadata do grupo o entrega: telefone OU LID. */
export type GroupParticipant = {
  /** E.164 ('+5591…') quando a Z-API mostra o número; null quando só há LID. */
  phoneE164: string | null;
  lid: string | null;
  isAdmin: boolean;
};

export type GroupSummary = {
  groupId: string;
  name: string | null;
};

export type GroupMetadata = {
  groupId: string;
  name: string | null;
  description: string | null;
  /** E.164 de quem criou o grupo, quando informado. */
  ownerE164: string | null;
  /** Só vem quando a sessão é admin do grupo. */
  invitationLink: string | null;
  adminOnlyMessage: boolean;
  adminOnlySettings: boolean;
  requireAdminApproval: boolean;
  participants: GroupParticipant[];
};

export type GroupSettings = {
  /** Só admins publicam (grupo de avisos). */
  adminOnlyMessage: boolean;
  /** Só admins mudam nome/foto/descrição. */
  adminOnlySettings: boolean;
  /** Quem entra pelo link espera aprovação de um admin. */
  requireAdminApproval: boolean;
  /** Só admins adicionam participantes. */
  adminOnlyAddMember: boolean;
};

export type SessionStatus = {
  connected: boolean;
};

export type QrCode = {
  imageBase64: string;
};

/** Mídia recebida da cliente, baixada do storage temporário da Z-API. */
export type DownloadedMedia = {
  data: Buffer;
  contentType: string | null;
};

/**
 * Contrato de mensageria WhatsApp. A Z-API é uma API NÃO-oficial (sessão de
 * WhatsApp Web): esta interface existe para trocarmos o adapter pela API
 * oficial (Cloud API) sem tocar nos serviços. Idempotência de envio fica no
 * serviço (wa_messages.dedupe_key), nunca no provider.
 */
/** Um chat como a Z-API o lista: quem, quando foi a última mensagem (qualquer direção), grupo ou não. */
export interface RecentChat {
  /** Telefone sem '+' ('5591…'), LID ('…@lid') ou id de grupo — como a Z-API entrega. */
  phone: string;
  /** LID do contato quando a Z-API o informa à parte ('…@lid'). */
  lid: string | null;
  name: string | null;
  lastMessageAt: Date;
  /** Mensagens que o WhatsApp da loja ainda não marcou como lidas. */
  unread: number;
  isGroup: boolean;
}

export interface MessagingProvider {
  /**
   * Os chats mais recentes da sessão (GET /chats da Z-API). É o que permite
   * ao vigia comparar "o que o WhatsApp recebeu" com "o que chegou ao
   * sistema" — o webhook pode falhar em silêncio (caso real: LID, 16/09/2026).
   */
  listRecentChats(limit: number): Promise<RecentChat[]>;
  sendText(input: OutboundTextMessage): Promise<SentMessage>;
  /** Envia imagem por URL (mensagem de mídia da Z-API). */
  sendImage(input: OutboundImageMessage): Promise<SentMessage>;
  /** Envia áudio por URL como mensagem de voz (POST /send-audio da Z-API). */
  sendAudio(input: OutboundAudioMessage): Promise<SentMessage>;
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
  /**
   * Marca uma mensagem RECEBIDA como lida (✓✓ azul) — o sinal de que a Lia
   * viu, enquanto o modelo pensa. Best-effort: quem chama trata o erro.
   */
  markAsRead(input: { fromE164: string; providerMessageId: string }): Promise<void>;
  /**
   * Baixa uma mídia recebida (foto, áudio) pela URL que veio no webhook. A
   * Z-API guarda o arquivo por ~30 dias numa URL pública. Lança quando a
   * URL não responde ou o arquivo passa de `maxBytes` — quem chama trata
   * como "mídia indisponível" (a conversa segue sem ela).
   */
  downloadMedia(input: { url: string; maxBytes: number }): Promise<DownloadedMedia>;

  // --- Grupos (Provador) ---------------------------------------------------
  // Grupo é um chat como outro para a Z-API: sendText/sendImage aceitam o id
  // de grupo no endereço. O que segue é o que só existe em grupo.

  /** Enquete nativa (POST /send-poll) — só grupos. */
  sendPoll(input: OutboundPollMessage): Promise<SentMessage>;
  /** Reage com emoji a uma mensagem (POST /send-reaction). Best-effort. */
  sendReaction(input: OutboundReaction): Promise<void>;
  /** Fixa uma mensagem no topo do chat (POST /pin-message). Best-effort. */
  pinMessage(input: { to: string; providerMessageId: string; duration: PinDuration }): Promise<void>;
  /** Todos os grupos de que a sessão participa (GET /groups). */
  listGroups(): Promise<GroupSummary[]>;
  /** Nome, configurações, link de convite e participantes (GET /group-metadata/{id}). */
  getGroupMetadata(groupId: string): Promise<GroupMetadata>;
  /** Link de convite do grupo (GET /group-invitation-link/{id}) — null quando a sessão não é admin. */
  getGroupInvitationLink(groupId: string): Promise<string | null>;
  /** Preferências do grupo (POST /update-group-settings) — exige a sessão como admin. */
  updateGroupSettings(groupId: string, settings: GroupSettings): Promise<void>;
  /** Remove participantes (POST /remove-participant) — endereços E.164 ou LID; exige admin. */
  removeGroupParticipants(groupId: string, addresses: string[]): Promise<void>;
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
