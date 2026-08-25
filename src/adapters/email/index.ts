import { getAdapterMode } from "../adapter-mode";
import { ResendEmailProvider } from "./client";
import { FakeEmailProvider } from "./fake";

export type OutgoingEmail = {
  to: string;
  subject: string;
  html: string;
  text?: string;
};

export interface EmailProvider {
  send(email: OutgoingEmail): Promise<void>;
}

let instance: EmailProvider | undefined;

export function getEmailProvider(): EmailProvider {
  if (!instance) {
    instance =
      getAdapterMode() === "real"
        ? new ResendEmailProvider()
        : new FakeEmailProvider();
  }
  return instance;
}
