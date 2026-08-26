// Contrato da CAIXA DE ENTRADA de e-mail (IMAP). É o par de leitura do
// adapter de envio (`adapters/email`, Resend): lá sai a mensagem, aqui volta a
// resposta do cliente.
//
// Regra do projeto: nenhum SDK de vendor sai daqui. O implementador real é
// `client.ts` (imapflow + mailparser); em dev/teste o `fake.ts` cobre o fluxo
// inteiro sem rede.
import { getAdapterMode } from "../adapter-mode";
import { ImapMailboxProvider } from "./client";
import { FakeMailboxProvider } from "./fake";

export const MAILBOX_ERROR_CODES = [
  "nao_configurado",
  "autenticacao",
  "indisponivel",
] as const;

export type MailboxErrorCode = (typeof MAILBOX_ERROR_CODES)[number];

/**
 * Falha tratável da caixa de entrada. `code` é o que o service usa para
 * decidir; `message` já vem em pt-BR e pode ser mostrada ao dono.
 */
export class MailboxError extends Error {
  readonly code: MailboxErrorCode;

  constructor(code: MailboxErrorCode, message: string) {
    super(message);
    this.name = "MailboxError";
    this.code = code;
  }
}

export type InboundAttachment = {
  filename: string;
  contentType: string;
  content: Uint8Array;
};

export type InboundEmail = {
  /**
   * Número da mensagem NA CAIXA (UID do IMAP), crescente e estável enquanto o
   * UIDVALIDITY da pasta não mudar. É o marcador que o polling guarda para
   * saber onde parou — não é identidade global da mensagem: para isso use
   * `messageId`.
   */
  uid: number;
  /** Message-ID SEM os `<>` (a forma nua é a que `core/email/threading` compara). */
  messageId: string;
  inReplyTo?: string;
  references: string[];
  from: { address: string; name?: string };
  to: string[];
  cc: string[];
  subject: string;
  textBody: string;
  htmlBody?: string;
  attachments: InboundAttachment[];
  receivedAt: Date;
};

export interface MailboxProvider {
  /**
   * Mensagens com UID MAIOR que `lastUid`, da mais antiga para a mais nova, no
   * máximo `limit`. `lastUid` 0 lê a caixa desde o começo.
   */
  fetchSince(lastUid: number, limit: number): Promise<InboundEmail[]>;
  /**
   * Guarda uma cópia da mensagem enviada na pasta de enviados, em RFC 822 cru.
   * Sem isso o dono abre o Gmail dele e vê só metade da conversa: as respostas
   * que o sistema mandou não aparecem em lugar nenhum.
   */
  appendToSent(raw: string): Promise<void>;
  markSeen(uid: number): Promise<void>;
}

/**
 * Existe caixa de entrada utilizável agora?
 *
 * Em modo fake (dev/testes) SEMPRE sim: o FakeMailboxProvider serve mensagens
 * de memória e o fluxo roda inteiro. Em modo real exige as QUATRO variáveis —
 * o IMAP não conecta faltando qualquer uma delas, e checar só o host deixaria
 * a falha para o meio do cron, uma vez a cada rodada, sem ninguém ver.
 */
export function isMailboxConfigured(): boolean {
  if (getAdapterMode() !== "real") return true;
  return Boolean(
    process.env.EMAIL_INBOX_HOST &&
      process.env.EMAIL_INBOX_PORT &&
      process.env.EMAIL_INBOX_USER &&
      process.env.EMAIL_INBOX_PASSWORD,
  );
}

let instance: MailboxProvider | undefined;

export function getMailboxProvider(): MailboxProvider {
  if (!instance) {
    instance =
      getAdapterMode() === "real"
        ? new ImapMailboxProvider()
        : new FakeMailboxProvider();
  }
  return instance;
}
