// Adapter REAL da caixa de entrada: IMAP com `imapflow` + parsing de MIME com
// `mailparser`. Usado apenas com ADAPTER_MODE=real; nos testes e em dev o
// FakeMailboxProvider cobre o fluxo.
//
// Por que POLLING e não IMAP IDLE (o push do protocolo): IDLE exige um
// processo vivo segurando a conexão aberta, e o deploy é Vercel serverless —
// cada invocação é efêmera e morre em segundos. Então cada rodada do cron
// conecta, lê o que chegou depois do último UID e fecha.
import { ImapFlow, type ImapFlowOptions } from "imapflow";
import { simpleParser } from "mailparser";
import { z } from "zod";

import { normalizeMessageId } from "@/core/email/threading";

import {
  MailboxError,
  type InboundAttachment,
  type InboundEmail,
  type MailboxProvider,
} from "./index";

const INBOX_PATH = "INBOX";

// Marca de pasta de enviados da extensão SPECIAL-USE (RFC 6154).
const SENT_SPECIAL_USE = "\\Sent";

// Servidor sem SPECIAL-USE não marca a pasta e o nome muda com o idioma da
// conta (o Gmail em pt-BR chama "[Gmail]/E-mails enviados"). Daí a busca ser
// primeiro pela marca e só depois por estes nomes.
const SENT_FALLBACK_NAMES = [
  "sent",
  "sent items",
  "sent mail",
  "enviados",
  "e-mails enviados",
  "itens enviados",
];

// ---------------------------------------------------------------------------
// Schemas da fronteira (loose: tanto o imapflow quanto o mailparser devolvem
// MUITO mais campos do que usamos, e novos campos aparecem entre versões).
// ---------------------------------------------------------------------------

const emailAddressSchema = z.looseObject({
  address: z.string().nullish(),
  name: z.string().nullish(),
});

const addressObjectSchema = z.looseObject({
  value: z.array(emailAddressSchema),
});

const addressFieldSchema = z.union([
  addressObjectSchema,
  z.array(addressObjectSchema),
]);

const attachmentSchema = z.looseObject({
  filename: z.string().nullish(),
  contentType: z.string().nullish(),
  // Buffer É um Uint8Array; guardamos o tipo neutro para não vazar Node no
  // contrato do adapter.
  content: z.instanceof(Uint8Array),
});

const parsedMailSchema = z.looseObject({
  messageId: z.string().nullish(),
  inReplyTo: z.string().nullish(),
  // O mailparser devolve string quando há UM id e array quando há vários.
  references: z.union([z.string(), z.array(z.string())]).nullish(),
  subject: z.string().nullish(),
  text: z.string().nullish(),
  // `false` é como o mailparser diz "esta mensagem não tem parte HTML".
  html: z.union([z.string(), z.literal(false)]).nullish(),
  date: z.date().nullish(),
  from: addressObjectSchema.nullish(),
  to: addressFieldSchema.nullish(),
  cc: addressFieldSchema.nullish(),
  attachments: z.array(attachmentSchema).nullish(),
});

const fetchedMessageSchema = z.looseObject({
  uid: z.number().int().positive(),
  source: z.instanceof(Uint8Array),
  /** Quando o SERVIDOR recebeu a mensagem (não é a data do cabeçalho). */
  internalDate: z.date().nullish(),
});

type FetchedMessage = z.infer<typeof fetchedMessageSchema>;
type AddressField = z.infer<typeof addressFieldSchema>;
type AddressObject = z.infer<typeof addressObjectSchema>;

// A classe AuthenticationFailure aparece no .d.ts do imapflow mas NÃO é
// exportada em runtime (só `ImapFlow` sai do módulo) — `instanceof` quebraria.
// A marca confiável é esta propriedade, que a classe carrega.
const authenticationFailureSchema = z.looseObject({
  authenticationFailed: z.literal(true),
});

const portSchema = z.coerce.number().int().positive().max(65535);

// ---------------------------------------------------------------------------

type MailboxCredentials = {
  host: string;
  port: number;
  user: string;
  password: string;
};

function getCredentials(): MailboxCredentials {
  const host = process.env.EMAIL_INBOX_HOST?.trim();
  const user = process.env.EMAIL_INBOX_USER?.trim();
  const password = process.env.EMAIL_INBOX_PASSWORD;
  const port = portSchema.safeParse(process.env.EMAIL_INBOX_PORT);
  if (!host || !user || !password || !port.success) {
    throw new MailboxError(
      "nao_configurado",
      "Caixa de entrada indisponível: EMAIL_INBOX_HOST, EMAIL_INBOX_PORT, " +
        "EMAIL_INBOX_USER e EMAIL_INBOX_PASSWORD precisam estar no ambiente.",
    );
  }
  return { host, port: port.data, user, password };
}

function buildOptions(): ImapFlowOptions {
  const { host, port, user, password } = getCredentials();
  return {
    host,
    port,
    // Exigimos IMAPS (porta 993): TLS desde o primeiro byte, sem depender de o
    // servidor anunciar STARTTLS.
    secure: true,
    auth: { user, pass: password },
    // Sem isto o imapflow entra em IDLE sozinho depois de cada comando. Aqui a
    // conexão vive poucos segundos e é fechada, então IDLE só acrescenta ida e
    // volta — e o comando seguinte teria de interrompê-lo.
    disableAutoIdle: true,
    // O logger padrão despeja cada comando IMAP no stdout: vira ruído nos logs
    // da Vercel e expõe assunto e remetente de quem escreveu.
    logger: false,
  };
}

function toMailboxError(error: unknown): MailboxError {
  if (error instanceof MailboxError) return error;
  if (authenticationFailureSchema.safeParse(error).success) {
    return new MailboxError(
      "autenticacao",
      "A caixa de e-mail recusou o login. Confira EMAIL_INBOX_USER e " +
        "EMAIL_INBOX_PASSWORD (no Gmail, precisa ser senha de app).",
    );
  }
  const detail = error instanceof Error ? error.message : null;
  return new MailboxError(
    "indisponivel",
    "Não foi possível ler a caixa de e-mail agora" +
      (detail ? `: ${detail}` : "."),
  );
}

function toAddressList(field: AddressField | null | undefined): string[] {
  if (!field) return [];
  const groups = Array.isArray(field) ? field : [field];
  const addresses: string[] = [];
  for (const group of groups) {
    for (const entry of group.value) {
      const address = entry.address?.trim();
      if (address) addresses.push(address);
    }
  }
  return addresses;
}

function toSender(from: AddressObject | null | undefined): InboundEmail["from"] {
  const first = from?.value[0];
  const address = first?.address?.trim() ?? "";
  const name = first?.name?.trim();
  return name ? { address, name } : { address };
}

function toReferences(
  value: string | string[] | null | undefined,
): string[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  const references: string[] = [];
  for (const item of list) {
    const id = normalizeMessageId(item);
    if (id) references.push(id);
  }
  return references;
}

function toAttachments(
  attachments: z.infer<typeof attachmentSchema>[] | null | undefined,
): InboundAttachment[] {
  return (attachments ?? []).map((attachment, index) => ({
    filename: attachment.filename?.trim() || `anexo-${index + 1}`,
    contentType: attachment.contentType?.trim() || "application/octet-stream",
    content: attachment.content,
  }));
}

async function toInboundEmail(message: FetchedMessage): Promise<InboundEmail> {
  const parsed = parsedMailSchema.parse(
    await simpleParser(Buffer.from(message.source)),
  );

  const inReplyTo = normalizeMessageId(parsed.inReplyTo);
  const html = typeof parsed.html === "string" ? parsed.html : undefined;

  return {
    uid: message.uid,
    // Message-ID é opcional no RFC 5322 e existe remetente que não manda. Sem
    // ele a conversa não threadeia, mas a mensagem não pode sumir: o UID é
    // único dentro da caixa e serve de identidade estável.
    messageId:
      normalizeMessageId(parsed.messageId) ?? `uid-${message.uid}@inbox.local`,
    ...(inReplyTo ? { inReplyTo } : {}),
    references: toReferences(parsed.references),
    from: toSender(parsed.from),
    to: toAddressList(parsed.to),
    cc: toAddressList(parsed.cc),
    subject: parsed.subject?.trim() ?? "",
    // Vazio quando a mensagem só tem parte HTML (o mailparser não inventa
    // text/plain); nesse caso quem exibe usa htmlBody.
    textBody: parsed.text ?? "",
    ...(html ? { htmlBody: html } : {}),
    attachments: toAttachments(parsed.attachments),
    receivedAt: message.internalDate ?? parsed.date ?? new Date(),
  };
}

async function findSentMailbox(client: ImapFlow): Promise<string> {
  const mailboxes = await client.list();
  const special = mailboxes.find((box) => box.specialUse === SENT_SPECIAL_USE);
  if (special) return special.path;
  const byName = mailboxes.find((box) =>
    SENT_FALLBACK_NAMES.includes(box.name.trim().toLowerCase()),
  );
  if (byName) return byName.path;
  throw new MailboxError(
    "indisponivel",
    "Não encontrei a pasta de enviados na caixa de e-mail; a cópia da " +
      "resposta não foi guardada.",
  );
}

export class ImapMailboxProvider implements MailboxProvider {
  async fetchSince(lastUid: number, limit: number): Promise<InboundEmail[]> {
    if (limit <= 0) return [];
    return this.withInbox(async (client) => {
      // "N:*" NUNCA volta vazio: quando não existe UID >= N, o servidor
      // responde com a ÚLTIMA mensagem da caixa. O filtro `> lastUid` abaixo
      // não é defensivo — sem ele o cron reprocessaria a mesma mensagem em
      // toda rodada.
      const found = await client.search(
        { uid: `${lastUid + 1}:*` },
        { uid: true },
      );
      const uids = (found === false ? [] : found)
        .filter((uid) => uid > lastUid)
        .sort((a, b) => a - b)
        .slice(0, limit);
      if (uids.length === 0) return [];

      const messages = await client.fetchAll(
        uids,
        { uid: true, source: true, internalDate: true },
        { uid: true },
      );
      const emails: InboundEmail[] = [];
      for (const message of messages) {
        emails.push(await toInboundEmail(fetchedMessageSchema.parse(message)));
      }
      return emails.sort((a, b) => a.uid - b.uid);
    });
  }

  async appendToSent(raw: string): Promise<void> {
    await this.withConnection(async (client) => {
      // \Seen porque é cópia do que NÓS mandamos: sem a marca, a caixa do dono
      // acusa não-lidas que ele nunca vai abrir.
      await client.append(await findSentMailbox(client), raw, ["\\Seen"]);
    });
  }

  async markSeen(uid: number): Promise<void> {
    await this.withInbox(async (client) => {
      await client.messageFlagsAdd(`${uid}`, ["\\Seen"], { uid: true });
    });
  }

  private async withInbox<T>(
    run: (client: ImapFlow) => Promise<T>,
  ): Promise<T> {
    return this.withConnection(async (client) => {
      await client.mailboxOpen(INBOX_PATH);
      return run(client);
    });
  }

  private async withConnection<T>(
    run: (client: ImapFlow) => Promise<T>,
  ): Promise<T> {
    const client = new ImapFlow(buildOptions());
    try {
      await client.connect();
      return await run(client);
    } catch (error) {
      throw toMailboxError(error);
    } finally {
      // Fechar SEMPRE: a invocação serverless termina e o socket fica
      // pendurado do lado do servidor, que conta sessão aberta (o Gmail limita
      // as simultâneas por conta e passa a recusar as próximas). O logout()
      // ainda fala com o servidor e pode falhar sozinho — aí o close() corta.
      try {
        await client.logout();
      } catch {
        client.close();
      }
    }
  }
}
