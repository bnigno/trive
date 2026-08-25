import type {
  MessagingProvider,
  OutboundTextMessage,
  SentMessage,
  SessionStatus,
} from "./index";

export type FakeSentMessage = {
  providerMessageId: string;
  toE164: string;
  body: string;
  dedupeKey?: string;
};

export class FakeMessagingProvider implements MessagingProvider {
  readonly sentMessages: FakeSentMessage[] = [];
  private readonly messageIdByDedupeKey = new Map<string, string>();
  private connected = true;
  private sequence = 0;

  async sendText(message: OutboundTextMessage): Promise<SentMessage> {
    if (!this.connected) {
      throw new Error("FakeMessagingProvider: WhatsApp session is disconnected");
    }
    if (message.dedupeKey) {
      const existingId = this.messageIdByDedupeKey.get(message.dedupeKey);
      if (existingId) {
        return { providerMessageId: existingId };
      }
    }
    this.sequence += 1;
    const providerMessageId = `fake-zapi-msg-${this.sequence}`;
    this.sentMessages.push({
      providerMessageId,
      toE164: message.toE164,
      body: message.body,
      dedupeKey: message.dedupeKey,
    });
    if (message.dedupeKey) {
      this.messageIdByDedupeKey.set(message.dedupeKey, providerMessageId);
    }
    return { providerMessageId };
  }

  async getSessionStatus(): Promise<SessionStatus> {
    if (this.connected) {
      return { connected: true };
    }
    return {
      connected: false,
      qrCodeUrl: "https://fake.zapi.local/qr-code.png",
    };
  }

  // --- Helpers de teste (não fazem parte da interface MessagingProvider) ---

  simulateDisconnect(): void {
    this.connected = false;
  }

  simulateReconnect(): void {
    this.connected = true;
  }

  reset(): void {
    this.sentMessages.length = 0;
    this.messageIdByDedupeKey.clear();
    this.connected = true;
    this.sequence = 0;
  }
}
