import type { EmailProvider, OutgoingEmail } from "./index";

export class FakeEmailProvider implements EmailProvider {
  readonly sentEmails: OutgoingEmail[] = [];

  async send(email: OutgoingEmail): Promise<void> {
    this.sentEmails.push({ ...email });
  }

  reset(): void {
    this.sentEmails.length = 0;
  }
}
