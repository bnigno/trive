import { getAdapterMode } from "../adapter-mode";
import { ResendEmailProvider } from "./client";
import { FakeEmailProvider } from "./fake";

export type OutgoingEmail = {
  to: string;
  subject: string;
  html: string;
  text?: string;
  /** Para onde a resposta do cliente deve voltar (a caixa lida por IMAP). */
  replyTo?: string;
  cc?: string[];
  /**
   * Cabeçalhos crus repassados ao provedor. É por aqui que In-Reply-To e
   * References (montados em `core/email/threading.ts`) chegam ao e-mail: sem
   * eles a resposta NÃO threadeia no Gmail do cliente — aparece como conversa
   * solta, fora do assunto original.
   */
  headers?: Record<string, string>;
};

export type SentEmail = {
  /**
   * Id do e-mail no provedor. É a âncora para casar a mensagem enviada com o
   * que volta pela caixa de entrada (e para consultar o envio no painel do
   * Resend quando o cliente diz que não recebeu).
   */
  providerMessageId: string;
};

export interface EmailProvider {
  send(email: OutgoingEmail): Promise<SentEmail>;
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
