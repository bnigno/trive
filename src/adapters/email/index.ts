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

/**
 * Existe canal de e-mail utilizável agora?
 *
 * Em modo fake (dev/testes) SEMPRE sim: o FakeEmailProvider registra o e-mail
 * em memória e o fluxo roda inteiro. Em modo real exige as DUAS variáveis —
 * sem EMAIL_FROM o Resend recusa o envio, então checar só a API key deixaria
 * o e-mail falhar lá na frente, dentro da fila.
 */
export function isEmailConfigured(): boolean {
  if (getAdapterMode() !== "real") return true;
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
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
