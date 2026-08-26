import type { EmailProvider, OutgoingEmail, SentEmail } from "./index";

export class FakeEmailProvider implements EmailProvider {
  readonly sentEmails: OutgoingEmail[] = [];

  private sequence = 0;

  async send(email: OutgoingEmail): Promise<SentEmail> {
    this.sentEmails.push({ ...email });
    this.sequence += 1;
    // Determinístico dentro da instância: o teste pode afirmar o id exato do
    // n-ésimo envio sem depender de relógio nem de aleatoriedade.
    return { providerMessageId: `fake-email-${this.sequence}` };
  }

  reset(): void {
    this.sentEmails.length = 0;
    this.sequence = 0;
  }
}
