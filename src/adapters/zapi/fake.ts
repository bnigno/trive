import type {
  MessagingProvider,
  OutboundTextMessage,
  QrCode,
  SentMessage,
  SessionStatus,
} from "./index";

export type FakeSentMessage = {
  providerMessageId: string;
  toE164: string;
  body: string;
};

// PNG 1x1 transparente — QR code fake para os fluxos de pareamento no admin.
export const FAKE_QR_CODE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export class FakeMessagingProvider implements MessagingProvider {
  readonly sentMessages: FakeSentMessage[] = [];
  private connected = true;
  private sequence = 0;

  async sendText(message: OutboundTextMessage): Promise<SentMessage> {
    if (!this.connected) {
      throw new Error("Sessão do WhatsApp desconectada (fake). Reconecte pelo QR code.");
    }
    this.sequence += 1;
    const providerMessageId = `fake-zapi-msg-${this.sequence}`;
    this.sentMessages.push({
      providerMessageId,
      toE164: message.toE164,
      body: message.body,
    });
    return { providerMessageId };
  }

  async getSessionStatus(): Promise<SessionStatus> {
    return { connected: this.connected };
  }

  async getQrCode(): Promise<QrCode | null> {
    if (this.connected) return null;
    return { imageBase64: FAKE_QR_CODE_PNG_BASE64 };
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
    this.connected = true;
    this.sequence = 0;
  }
}
