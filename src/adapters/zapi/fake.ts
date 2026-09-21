import { isWaGroupId } from "@/lib/phone";

import type {
  DownloadedMedia,
  GroupMetadata,
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

export type FakeSentMessage = {
  providerMessageId: string;
  toE164: string;
  body: string;
  typingSeconds?: number;
  quotedProviderMessageId?: string;
  mentionedPhones?: string[];
};

// PNG 1x1 transparente — QR code fake para os fluxos de pareamento no admin.
export const FAKE_QR_CODE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export class FakeMessagingProvider implements MessagingProvider {
  readonly sentMessages: FakeSentMessage[] = [];
  readonly sentImages: (OutboundImageMessage & { providerMessageId: string })[] = [];
  readonly sentAudios: (OutboundAudioMessage & { providerMessageId: string })[] = [];
  readonly sentOptionLists: (OutboundOptionListMessage & {
    providerMessageId: string;
  })[] = [];
  private connected = true;
  // Contador ÚNICO para todos os tipos de mensagem (texto, imagem, lista):
  // espelha a Z-API real, onde o id é global por sessão, não por endpoint.
  private sequence = 0;
  // Sufixo único por instância: zapi_message_id é UNIQUE no banco, e um
  // contador que reinicia a cada processo colide com execuções anteriores
  // quando o fake roda contra um banco persistente (demos no dev).
  private runId = Math.random().toString(36).slice(2, 8);

  private nextProviderMessageId(): string {
    if (!this.connected) {
      throw new Error("Sessão do WhatsApp desconectada (fake). Reconecte pelo QR code.");
    }
    this.sequence += 1;
    return `fake-zapi-msg-${this.runId}-${this.sequence}`;
  }

  async sendText(message: OutboundTextMessage): Promise<SentMessage> {
    const providerMessageId = this.nextProviderMessageId();
    this.sentMessages.push({
      providerMessageId,
      toE164: message.toE164,
      body: message.body,
      ...(message.typingSeconds !== undefined ? { typingSeconds: message.typingSeconds } : {}),
      ...(message.quotedProviderMessageId !== undefined
        ? { quotedProviderMessageId: message.quotedProviderMessageId }
        : {}),
      ...(message.mentionedPhones !== undefined ? { mentionedPhones: [...message.mentionedPhones] } : {}),
    });
    return { providerMessageId };
  }

  // --- Grupos ---------------------------------------------------------------

  readonly sentPolls: (OutboundPollMessage & { providerMessageId: string })[] = [];
  readonly sentReactions: OutboundReaction[] = [];
  readonly pinnedMessages: { to: string; providerMessageId: string; duration: PinDuration }[] = [];
  readonly groupSettingsUpdates: { groupId: string; settings: GroupSettings }[] = [];
  readonly removedParticipants: { groupId: string; addresses: string[] }[] = [];
  /** Grupos "existentes" na sessão fake: os testes semeiam com setGroup(). */
  private readonly groups = new Map<string, GroupMetadata>();

  async sendPoll(message: OutboundPollMessage): Promise<SentMessage> {
    // Paridade com o real: a Z-API só aceita enquete em grupo.
    if (!isWaGroupId(message.toGroupId)) {
      throw new Error("Z-API respondeu HTTP 400 em /send-poll.");
    }
    const providerMessageId = this.nextProviderMessageId();
    this.sentPolls.push({ ...message, options: [...message.options], providerMessageId });
    return { providerMessageId };
  }

  async sendReaction(input: OutboundReaction): Promise<void> {
    if (!this.connected) {
      throw new Error("Sessão do WhatsApp desconectada (fake). Reconecte pelo QR code.");
    }
    this.sentReactions.push({ ...input });
  }

  async pinMessage(input: { to: string; providerMessageId: string; duration: PinDuration }): Promise<void> {
    if (!this.connected) {
      throw new Error("Sessão do WhatsApp desconectada (fake). Reconecte pelo QR code.");
    }
    this.pinnedMessages.push({ ...input });
  }

  async listGroups(): Promise<GroupSummary[]> {
    if (!this.connected) throw new Error("Z-API desconectada (fake).");
    return [...this.groups.values()].map((group) => ({ groupId: group.groupId, name: group.name }));
  }

  async getGroupMetadata(groupId: string): Promise<GroupMetadata> {
    const group = this.groups.get(groupId);
    // Paridade com o real: grupo desconhecido → a Z-API responde 4xx.
    if (!group) throw new Error("Z-API respondeu HTTP 404 em /group-metadata.");
    return { ...group, participants: group.participants.map((p) => ({ ...p })) };
  }

  async getGroupInvitationLink(groupId: string): Promise<string | null> {
    const group = this.groups.get(groupId);
    if (!group) throw new Error("Z-API respondeu HTTP 404 em /group-invitation-link.");
    return group.invitationLink;
  }

  async updateGroupSettings(groupId: string, settings: GroupSettings): Promise<void> {
    const group = this.groups.get(groupId);
    if (!group) throw new Error("Z-API respondeu HTTP 404 em /update-group-settings.");
    this.groupSettingsUpdates.push({ groupId, settings: { ...settings } });
    this.groups.set(groupId, {
      ...group,
      adminOnlyMessage: settings.adminOnlyMessage,
      adminOnlySettings: settings.adminOnlySettings,
      requireAdminApproval: settings.requireAdminApproval,
    });
  }

  async removeGroupParticipants(groupId: string, addresses: string[]): Promise<void> {
    if (addresses.length === 0) return;
    const group = this.groups.get(groupId);
    if (!group) throw new Error("Z-API respondeu HTTP 404 em /remove-participant.");
    this.removedParticipants.push({ groupId, addresses: [...addresses] });
    const gone = new Set(addresses);
    this.groups.set(groupId, {
      ...group,
      participants: group.participants.filter(
        (p) => !((p.phoneE164 && gone.has(p.phoneE164)) || (p.lid && gone.has(p.lid))),
      ),
    });
  }

  /** Semeia (ou substitui) um grupo que a sessão fake "participa". */
  setGroup(group: GroupMetadata): void {
    this.groups.set(group.groupId, { ...group, participants: group.participants.map((p) => ({ ...p })) });
  }

  async sendImage(message: OutboundImageMessage): Promise<SentMessage> {
    const providerMessageId = this.nextProviderMessageId();
    this.sentImages.push({ ...message, providerMessageId });
    return { providerMessageId };
  }

  async sendAudio(message: OutboundAudioMessage): Promise<SentMessage> {
    const providerMessageId = this.nextProviderMessageId();
    this.sentAudios.push({ ...message, providerMessageId });
    return { providerMessageId };
  }

  async sendOptionList(message: OutboundOptionListMessage): Promise<SentMessage> {
    const providerMessageId = this.nextProviderMessageId();
    this.sentOptionLists.push({ ...message, providerMessageId });
    return { providerMessageId };
  }

  /** O que GET /chats devolveria: o teste do vigia preenche. */
  recentChats: RecentChat[] = [];

  async listRecentChats(limit: number): Promise<RecentChat[]> {
    if (!this.connected) throw new Error("Z-API desconectada (fake).");
    return this.recentChats.slice(0, limit);
  }

  async getSessionStatus(): Promise<SessionStatus> {
    return { connected: this.connected };
  }

  async getQrCode(): Promise<QrCode | null> {
    if (this.connected) return null;
    return { imageBase64: FAKE_QR_CODE_PNG_BASE64 };
  }

  private readonly nonexistentPhones = new Set<string>();

  async phoneExists(toE164: string): Promise<boolean> {
    return !this.nonexistentPhones.has(toE164);
  }

  /** Mensagens recebidas marcadas como lidas (✓✓ azul), na ordem. */
  readonly readReceipts: { fromE164: string; providerMessageId: string }[] = [];

  async markAsRead(input: { fromE164: string; providerMessageId: string }): Promise<void> {
    if (!this.connected) {
      throw new Error("Sessão do WhatsApp desconectada (fake). Reconecte pelo QR code.");
    }
    // Paridade com o real: número sem conversa → a Z-API responde 4xx.
    if (this.nonexistentPhones.has(input.fromE164)) {
      throw new Error("Z-API respondeu HTTP 404 em /read-message.");
    }
    this.readReceipts.push({ ...input });
  }

  // Mídias "recebidas": os testes semeiam por URL; URL desconhecida simula a
  // URL expirada da Z-API (lança, como o cliente real).
  private readonly mediaFixtures = new Map<string, DownloadedMedia>();

  async downloadMedia(input: { url: string; maxBytes: number }): Promise<DownloadedMedia> {
    const fixture = this.mediaFixtures.get(input.url);
    if (!fixture) throw new Error("Mídia da Z-API indisponível (fake: sem fixture).");
    if (fixture.data.byteLength > input.maxBytes) {
      throw new Error("Mídia da Z-API maior que o limite aceito.");
    }
    return fixture;
  }

  setMediaFixture(url: string, data: Buffer | Uint8Array, contentType: string | null): void {
    this.mediaFixtures.set(url, { data: Buffer.from(data), contentType });
  }

  // --- Helpers de teste (não fazem parte da interface MessagingProvider) ---

  /** Marca um número como SEM WhatsApp (phoneExists passa a responder false). */
  setPhoneExists(toE164: string, exists: boolean): void {
    if (exists) this.nonexistentPhones.delete(toE164);
    else this.nonexistentPhones.add(toE164);
  }

  simulateDisconnect(): void {
    this.connected = false;
  }

  simulateReconnect(): void {
    this.connected = true;
  }

  reset(): void {
    this.sentMessages.length = 0;
    this.sentImages.length = 0;
    this.sentAudios.length = 0;
    this.sentOptionLists.length = 0;
    this.sentPolls.length = 0;
    this.sentReactions.length = 0;
    this.pinnedMessages.length = 0;
    this.groupSettingsUpdates.length = 0;
    this.removedParticipants.length = 0;
    this.groups.clear();
    this.readReceipts.length = 0;
    this.connected = true;
    this.sequence = 0;
    this.runId = Math.random().toString(36).slice(2, 8);
    this.nonexistentPhones.clear();
    this.mediaFixtures.clear();
  }
}
