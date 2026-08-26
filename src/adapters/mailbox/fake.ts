// Caixa de entrada FAKE: mensagens em memória, semeáveis pelo teste. É o que
// permite rodar o atendimento por e-mail inteiro no PGlite — sem rede, sem
// servidor IMAP e sem conta de e-mail de verdade.
import {
  MailboxError,
  type InboundAttachment,
  type InboundEmail,
  type MailboxErrorCode,
  type MailboxProvider,
} from "./index";

export type FakeMailboxMethod = "fetchSince" | "appendToSent" | "markSeen";

export type SeedInboundEmailInput = {
  /** Padrão: o próximo UID da caixa (1, 2, 3, …). */
  uid?: number;
  /** Padrão: derivado do UID, único dentro da instância. */
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  /** String vira `{ address }`; use o objeto quando o nome importar. */
  from: { address: string; name?: string } | string;
  to?: string[];
  cc?: string[];
  subject?: string;
  textBody?: string;
  htmlBody?: string;
  attachments?: InboundAttachment[];
  receivedAt?: Date;
};

const DEFAULT_ERROR_MESSAGES: Record<MailboxErrorCode, string> = {
  nao_configurado:
    "Caixa de entrada indisponível: provedor não configurado.",
  autenticacao: "A caixa de e-mail recusou o login.",
  indisponivel:
    "Não foi possível ler a caixa de e-mail agora. Tente de novo em alguns " +
    "instantes.",
};

/**
 * O que sai do provider é CÓPIA: mexer no retorno não pode alterar a caixa,
 * do mesmo jeito que mexer não altera o servidor IMAP.
 */
function clone(email: InboundEmail): InboundEmail {
  return {
    ...email,
    from: { ...email.from },
    references: [...email.references],
    to: [...email.to],
    cc: [...email.cc],
    attachments: email.attachments.map((attachment) => ({
      ...attachment,
      content: attachment.content.slice(),
    })),
    receivedAt: new Date(email.receivedAt),
  };
}

export class FakeMailboxProvider implements MailboxProvider {
  /** Mensagens RFC 822 cruas guardadas na pasta de enviados. */
  readonly appendedToSent: string[] = [];
  /** UIDs marcados como lidos, na ordem em que foram marcados. */
  readonly seenUids: number[] = [];

  private readonly messages: InboundEmail[] = [];
  private uidSequence = 0;
  private readonly nextFailures = new Map<FakeMailboxMethod, MailboxError>();

  // --- Helpers de teste (fora da interface MailboxProvider) ---

  /** Coloca uma mensagem na caixa como se ela tivesse acabado de chegar. */
  seed(input: SeedInboundEmailInput): InboundEmail {
    const uid = input.uid ?? this.uidSequence + 1;
    this.uidSequence = Math.max(this.uidSequence, uid);
    const from =
      typeof input.from === "string" ? { address: input.from } : input.from;
    const email: InboundEmail = {
      uid,
      messageId: input.messageId ?? `fake-inbox-${uid}@trive.local`,
      ...(input.inReplyTo !== undefined ? { inReplyTo: input.inReplyTo } : {}),
      references: input.references ?? [],
      from,
      to: input.to ?? [],
      cc: input.cc ?? [],
      subject: input.subject ?? "",
      textBody: input.textBody ?? "",
      ...(input.htmlBody !== undefined ? { htmlBody: input.htmlBody } : {}),
      attachments: input.attachments ?? [],
      receivedAt: input.receivedAt ?? new Date(),
    };
    this.messages.push(clone(email));
    return clone(email);
  }

  /** Tudo que está na caixa, da mensagem mais antiga para a mais nova. */
  list(): InboundEmail[] {
    return [...this.messages].sort((a, b) => a.uid - b.uid).map(clone);
  }

  /** Faz a PRÓXIMA chamada de `method` falhar com esse código. */
  failNext(
    method: FakeMailboxMethod,
    error: MailboxErrorCode,
    message?: string,
  ): void {
    this.nextFailures.set(
      method,
      new MailboxError(error, message ?? DEFAULT_ERROR_MESSAGES[error]),
    );
  }

  reset(): void {
    this.messages.length = 0;
    this.appendedToSent.length = 0;
    this.seenUids.length = 0;
    this.uidSequence = 0;
    this.nextFailures.clear();
  }

  private consumeFailure(method: FakeMailboxMethod): void {
    const failure = this.nextFailures.get(method);
    if (!failure) return;
    this.nextFailures.delete(method);
    throw failure;
  }

  // --- Contrato MailboxProvider ---

  async fetchSince(lastUid: number, limit: number): Promise<InboundEmail[]> {
    this.consumeFailure("fetchSince");
    if (limit <= 0) return [];
    return this.messages
      .filter((email) => email.uid > lastUid)
      .sort((a, b) => a.uid - b.uid)
      .slice(0, limit)
      .map(clone);
  }

  async appendToSent(raw: string): Promise<void> {
    this.consumeFailure("appendToSent");
    this.appendedToSent.push(raw);
  }

  async markSeen(uid: number): Promise<void> {
    this.consumeFailure("markSeen");
    // Igual ao IMAP real: marcar um UID que não existe mais não é erro.
    this.seenUids.push(uid);
  }
}
