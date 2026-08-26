// Caixa de entrada de e-mail (Fase 6): o par de leitura do canal transacional.
// A ingestão vem do cron (IMAP → MailboxProvider) e é idempotente pelo UNIQUE
// (source, external_event_id) de inbound_events; o agrupamento em conversas é
// decidido no core (`core/email/threading`), nunca aqui. O envio da resposta
// do dono NUNCA sai inline: grava a linha 'queued' e enfileira 'email.send' na
// MESMA transação — se o provedor estiver fora do ar, nada se perde.
import { randomUUID } from "node:crypto";

import { and, asc, count, desc, eq, exists, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";

import { isEmailConfigured, type EmailProvider } from "@/adapters/email";
import type { MailboxProvider } from "@/adapters/mailbox";
import type { FileStorage } from "@/adapters/storage";
import {
  buildReplyHeaders,
  normalizeMessageId,
  normalizeSubject,
  threadKeyFor,
} from "@/core/email/threading";
import {
  auditLog,
  customers,
  emailMessages,
  emailThreads,
  inboundEvents,
} from "@/db/schema";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";
import { ServiceError } from "@/services/settings";

/** Quantas mensagens a rodada do cron traz da caixa por vez. */
const INBOX_POLL_LIMIT = 25;

const SNIPPET_MAX_CHARS = 160;

const DEFAULT_SUBJECT = "(sem assunto)";

// Endereço reservado para RFC 2606: mensagem sem remetente utilizável não pode
// derrubar a rodada do cron nem virar chave de conversa vazia.
const UNKNOWN_SENDER = "desconhecido@sem-remetente.invalid";

// Colunas jsonb chegam como `unknown` do Drizzle: PARSE na saída do banco
// (nunca cast). `.catch` cobre linha antiga/torta sem derrubar a tela.
const attachmentRefSchema = z.object({
  storagePath: z.string(),
  filename: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
});

export type EmailAttachmentRef = z.infer<typeof attachmentRefSchema>;

const attachmentRefsSchema = z.array(attachmentRefSchema).catch([]);
const addressListSchema = z.array(z.string()).catch([]);
const messageIdListSchema = z.array(z.string()).catch([]);

// "Não vista" = inbound gravada depois da última leitura do dono; thread nunca
// aberta (owner_last_seen_at NULL) conta tudo desde a época. É created_at (o
// instante em que a mensagem entrou no painel), não a data do cabeçalho: um
// e-mail antigo ingerido hoje continua sendo novidade para o dono.
const unseenInboundFilter = and(
  eq(emailMessages.direction, "inbound"),
  gt(
    emailMessages.createdAt,
    sql`coalesce(${emailThreads.ownerLastSeenAt}, 'epoch'::timestamptz)`,
  ),
);

// A lista ordena por ATIVIDADE, não por updated_at: o trigger
// email_threads_set_updated_at bumpa updated_at em QUALQUER update — inclusive
// o "visto" —, e ordenar por ele faria a conversa pular de lugar toda vez que
// o dono a abrisse.
const lastActivityAt = sql`greatest(
  coalesce(${emailThreads.lastInboundAt}, 'epoch'::timestamptz),
  coalesce(${emailThreads.lastOutboundAt}, 'epoch'::timestamptz),
  ${emailThreads.createdAt}
)`;

// ---------------------------------------------------------------------------
// Helpers de texto e de endereço
// ---------------------------------------------------------------------------

function buildSnippet(textBody: string, htmlBody?: string | null): string {
  const source =
    textBody.trim() !== "" ? textBody : (htmlBody ?? "").replace(/<[^>]*>/g, " ");
  const flat = source.replace(/\s+/g, " ").trim();
  return flat.length <= SNIPPET_MAX_CHARS
    ? flat
    : `${flat.slice(0, SNIPPET_MAX_CHARS - 1)}…`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** A resposta do dono é texto puro: vira HTML com parágrafos, sempre escapado. */
function bodyToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map(
      (paragraph) =>
        `<p style="margin:0 0 12px;font-size:15px;line-height:1.5;color:#111;">${escapeHtml(
          paragraph,
        ).replaceAll("\n", "<br />")}</p>`,
    )
    .join("\n");
}

/** Endereço nu (sem o nome de exibição) do remetente configurado no Resend. */
function ownFromAddress(): string {
  const raw = process.env.EMAIL_FROM?.trim();
  if (!raw) return UNKNOWN_SENDER;
  const match = raw.match(/<([^>]+)>/);
  return (match?.[1] ?? raw).trim().toLowerCase();
}

/**
 * Para onde a resposta do cliente deve voltar: a caixa lida por IMAP. Sem ela,
 * o cliente responderia para o EMAIL_FROM e a conversa morreria fora do painel.
 */
function inboxReplyToAddress(): string | null {
  const raw = process.env.EMAIL_INBOX_USER?.trim();
  return raw ? raw.toLowerCase() : null;
}

function replySubject(threadSubject: string): string {
  const base = normalizeSubject(threadSubject) || DEFAULT_SUBJECT;
  return `Re: ${base}`;
}

/** "<a> <b>" → ["a", "b"] — o inverso do que `buildReplyHeaders` escreve. */
function messageIdsFromHeader(value: string): string[] {
  return value
    .split(/\s+/)
    .map((item) => normalizeMessageId(item))
    .filter((id): id is string => id !== null);
}

// ---------------------------------------------------------------------------
// Ingestão (chamada pelo cron 'email-poll')
// ---------------------------------------------------------------------------

const inboundAttachmentSchema = z.object({
  filename: z.string(),
  contentType: z.string(),
  content: z.custom<Uint8Array>(
    (value) => value instanceof Uint8Array,
    "Anexo sem conteúdo binário.",
  ),
});

// Fronteira com o adapter de caixa de entrada: parse, não cast.
const inboundEmailSchema = z.object({
  uid: z.number().int().nonnegative(),
  messageId: z.string(),
  inReplyTo: z.string().optional(),
  references: z.array(z.string()).default([]),
  from: z.object({ address: z.string(), name: z.string().optional() }),
  to: z.array(z.string()).default([]),
  cc: z.array(z.string()).default([]),
  subject: z.string().default(""),
  textBody: z.string().default(""),
  htmlBody: z.string().optional(),
  attachments: z.array(inboundAttachmentSchema).default([]),
  receivedAt: z.date(),
});

export type IngestInboundEmailInput = z.input<typeof inboundEmailSchema>;

export type IngestInboundEmailResult =
  | { action: "duplicate" }
  | { action: "ingested"; threadId: string; emailMessageId: string };

/**
 * Segmento seguro de path: Message-ID e nome de anexo aceitam quase qualquer
 * caractere (barra, espaço, acento) e o bucket não.
 */
function storageSegment(value: string): string {
  const safe = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return safe.slice(0, 100) || "sem-nome";
}

async function uploadAttachments(
  storage: FileStorage,
  messageId: string,
  attachments: z.infer<typeof inboundAttachmentSchema>[],
): Promise<EmailAttachmentRef[]> {
  const refs: EmailAttachmentRef[] = [];
  for (const [index, attachment] of attachments.entries()) {
    // O índice no nome do arquivo é obrigatório: dois anexos com o MESMO nome
    // na mesma mensagem viraram um objeto só sem ele.
    const path = `emails/${storageSegment(messageId)}/${index + 1}-${storageSegment(
      attachment.filename,
    )}`;
    await storage.upload({
      path,
      data: attachment.content,
      contentType: attachment.contentType,
    });
    refs.push({
      storagePath: path,
      filename: attachment.filename,
      contentType: attachment.contentType,
      sizeBytes: attachment.content.byteLength,
    });
  }
  return refs;
}

/**
 * A conversa a que esta mensagem pertence, na ordem que o core manda: primeiro
 * a mensagem-pai já gravada (a raiz de References/In-Reply-To), porque a
 * PRIMEIRA mensagem de uma conversa tem chave 'sub:' e as respostas dela têm
 * 'mid:' — só o pai junta as duas pontas. Thread arquivada não entra na busca:
 * resposta nova volta a aparecer na caixa, em conversa aberta.
 */
async function resolveThreadForInbound(
  tx: DbOrTx,
  input: {
    parentIds: string[];
    threadKey: string;
    subject: string;
    participantEmail: string;
    participantName: string | null;
    customerId: string | null;
    receivedAt: Date;
  },
): Promise<string> {
  if (input.parentIds.length > 0) {
    const [parent] = await tx
      .select({ threadId: emailMessages.threadId })
      .from(emailMessages)
      .innerJoin(emailThreads, eq(emailThreads.id, emailMessages.threadId))
      .where(
        and(
          inArray(emailMessages.messageId, input.parentIds),
          ne(emailThreads.status, "archived"),
        ),
      )
      .orderBy(desc(emailMessages.createdAt))
      .limit(1);

    if (parent) {
      await tx
        .update(emailThreads)
        .set({
          lastInboundAt: input.receivedAt,
          ...(input.customerId
            ? {
                customerId: sql`coalesce(${emailThreads.customerId}, ${input.customerId})`,
              }
            : {}),
        })
        .where(eq(emailThreads.id, parent.threadId));
      return parent.threadId;
    }
  }

  // No máximo UMA thread não-arquivada por thread_key (unique parcial): o
  // upsert reaproveita a aberta; arquivada não conflita e nasce outra.
  const [thread] = await tx
    .insert(emailThreads)
    .values({
      threadKey: input.threadKey,
      subject: input.subject,
      participantEmail: input.participantEmail,
      participantName: input.participantName,
      customerId: input.customerId,
      lastInboundAt: input.receivedAt,
    })
    .onConflictDoUpdate({
      target: emailThreads.threadKey,
      targetWhere: sql`${emailThreads.status} <> 'archived'`,
      set: {
        lastInboundAt: input.receivedAt,
        // Nunca sobrescreve um vínculo existente com outro cliente.
        ...(input.customerId
          ? {
              customerId: sql`coalesce(${emailThreads.customerId}, ${input.customerId})`,
            }
          : {}),
      },
    })
    .returning({ id: emailThreads.id });
  return thread.id;
}

/**
 * Grava um e-mail recebido: registra o evento inbound (idempotência), garante
 * a conversa, sobe os anexos e liga o cliente conhecido pelo endereço.
 * Reentrega do MESMO Message-ID devolve { action: 'duplicate' } sem gravar nada.
 */
export async function ingestInboundEmail(
  db: DbOrTx,
  storage: FileStorage,
  email: IngestInboundEmailInput,
): Promise<IngestInboundEmailResult> {
  const parsed = inboundEmailSchema.parse(email);

  // Message-ID é opcional no RFC 5322: sem ele o UID da caixa é a identidade
  // (mesmo critério do adapter, para as duas pontas derivarem a MESMA chave).
  const messageId =
    normalizeMessageId(parsed.messageId) ?? `uid-${parsed.uid}@inbox.local`;
  const participantEmail =
    parsed.from.address.trim().toLowerCase() || UNKNOWN_SENDER;
  const participantName = parsed.from.name?.trim() || null;
  const rawSubject = parsed.subject.trim();
  const references = parsed.references
    .map((reference) => normalizeMessageId(reference))
    .filter((id): id is string => id !== null);
  const inReplyTo = normalizeMessageId(parsed.inReplyTo);

  // Reentrega: sai antes de subir anexo de novo. O árbitro continua sendo o
  // UNIQUE lá dentro da transação — isto aqui só evita o trabalho à toa.
  const [alreadyReceived] = await db
    .select({ id: inboundEvents.id })
    .from(inboundEvents)
    .where(
      and(
        eq(inboundEvents.source, "email"),
        eq(inboundEvents.externalEventId, messageId),
      ),
    )
    .limit(1);
  if (alreadyReceived) return { action: "duplicate" };

  const attachments = await uploadAttachments(
    storage,
    messageId,
    parsed.attachments,
  );

  return db.transaction(async (tx) => {
    const insertedInbound = await tx
      .insert(inboundEvents)
      .values({
        source: "email",
        externalEventId: messageId,
        eventType: "email.received",
        // Envelope, sem os corpos: eles ficam em email_messages e guardar duas
        // cópias de cada e-mail engorda a tabela de eventos à toa.
        payload: {
          uid: parsed.uid,
          messageId,
          inReplyTo,
          references,
          from: { address: participantEmail, name: participantName },
          to: parsed.to,
          cc: parsed.cc,
          subject: rawSubject,
          attachments: attachments.map((attachment) => attachment.storagePath),
          receivedAt: parsed.receivedAt.toISOString(),
        },
      })
      .onConflictDoNothing({
        target: [inboundEvents.source, inboundEvents.externalEventId],
      })
      .returning({ id: inboundEvents.id });

    const inboundId = insertedInbound[0]?.id;
    if (!inboundId) return { action: "duplicate" } as const;

    const [customer] = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(
        and(eq(customers.email, participantEmail), isNull(customers.deletedAt)),
      )
      .limit(1);

    const threadKey = threadKeyFor({
      messageId,
      ...(inReplyTo ? { inReplyTo } : {}),
      references,
      subject: rawSubject,
      participantEmail,
    });

    const threadId = await resolveThreadForInbound(tx, {
      parentIds: [...new Set([...references, ...(inReplyTo ? [inReplyTo] : [])])],
      threadKey,
      subject: normalizeSubject(rawSubject) || DEFAULT_SUBJECT,
      participantEmail,
      participantName,
      customerId: customer?.id ?? null,
      receivedAt: parsed.receivedAt,
    });

    const [message] = await tx
      .insert(emailMessages)
      .values({
        threadId,
        direction: "inbound",
        messageId,
        inReplyTo,
        referencesIds: references,
        fromAddress: participantEmail,
        fromName: participantName,
        toAddresses: parsed.to,
        ccAddresses: parsed.cc,
        subject: rawSubject,
        textBody: parsed.textBody,
        htmlBody: parsed.htmlBody ?? null,
        snippet: buildSnippet(parsed.textBody, parsed.htmlBody),
        attachments,
        imapUid: parsed.uid,
        // O CHECK da tabela só admite queued/sent/failed. Para a inbound,
        // 'sent' quer dizer "entregue, nada pendente": deixá-la 'queued' faria
        // qualquer varredura de pendências tratar e-mail RECEBIDO como e-mail
        // a enviar.
        status: "sent",
      })
      .onConflictDoNothing({ target: emailMessages.messageId })
      .returning({ id: emailMessages.id });

    if (!message) return { action: "duplicate" } as const;

    await tx
      .update(inboundEvents)
      .set({ status: "done", processedAt: new Date() })
      .where(eq(inboundEvents.id, inboundId));

    return { action: "ingested", threadId, emailMessageId: message.id } as const;
  });
}

export type PollEmailInboxResult = {
  fetched: number;
  ingested: number;
  duplicates: number;
  /** Maior UID conhecido depois da rodada — cursor da próxima. */
  lastUid: number;
};

/**
 * Uma rodada de leitura da caixa: busca a partir do maior imap_uid já gravado
 * e ingere em ordem. Uma mensagem problemática INTERROMPE a rodada de
 * propósito — pular seria perder o e-mail em silêncio, e a rodada seguinte
 * tenta de novo (a ingestão é idempotente).
 */
export async function pollEmailInbox(
  db: DbOrTx,
  mailbox: MailboxProvider,
  storage: FileStorage,
  options: { limit?: number } = {},
): Promise<PollEmailInboxResult> {
  const limit = options.limit ?? INBOX_POLL_LIMIT;

  const [cursor] = await db
    .select({
      lastUid: sql<number>`coalesce(max(${emailMessages.imapUid}), 0)`,
    })
    .from(emailMessages);
  let lastUid = Number(cursor?.lastUid ?? 0);

  const emails = await mailbox.fetchSince(lastUid, limit);
  let ingested = 0;
  let duplicates = 0;

  for (const email of emails) {
    const result = await ingestInboundEmail(db, storage, email);
    if (result.action === "ingested") ingested += 1;
    else duplicates += 1;
    lastUid = Math.max(lastUid, email.uid);

    try {
      await mailbox.markSeen(email.uid);
    } catch (error) {
      // Melhor esforço: a mensagem JÁ está no painel. Não conseguir marcá-la
      // como lida no IMAP não pode desfazer nem repetir a ingestão.
      console.warn(`[email-poll] markSeen(${email.uid}) falhou.`, error);
    }
  }

  return { fetched: emails.length, ingested, duplicates, lastUid };
}

// ---------------------------------------------------------------------------
// Leitura — lista, thread, cauda, "visto" e badge
// ---------------------------------------------------------------------------

export interface EmailThreadListItem {
  id: string;
  subject: string;
  participantEmail: string;
  participantName: string | null;
  customerName: string | null;
  status: string;
  lastMessageAt: Date | null;
  lastMessageDirection: "inbound" | "outbound" | null;
  lastMessageSnippet: string | null;
  unreadCount: number;
}

export async function listEmailThreads(
  db: DbOrTx,
  options: { limit?: number; status?: "open" | "archived" } = {},
): Promise<EmailThreadListItem[]> {
  const limit = options.limit ?? 50;
  const status = options.status ?? "open";

  const rows = await db
    .select({
      id: emailThreads.id,
      subject: emailThreads.subject,
      participantEmail: emailThreads.participantEmail,
      participantName: emailThreads.participantName,
      customerName: customers.fullName,
      status: emailThreads.status,
    })
    .from(emailThreads)
    .leftJoin(customers, eq(customers.id, emailThreads.customerId))
    .where(eq(emailThreads.status, status))
    .orderBy(desc(lastActivityAt))
    .limit(limit);

  if (rows.length === 0) return [];

  // Última mensagem de cada conversa em uma única consulta (DISTINCT ON).
  const ids = rows.map((row) => row.id);
  const lastMessages = await db
    .selectDistinctOn([emailMessages.threadId], {
      threadId: emailMessages.threadId,
      direction: emailMessages.direction,
      snippet: emailMessages.snippet,
      createdAt: emailMessages.createdAt,
    })
    .from(emailMessages)
    .where(inArray(emailMessages.threadId, ids))
    .orderBy(
      emailMessages.threadId,
      desc(emailMessages.createdAt),
      desc(emailMessages.id),
    );

  const byThread = new Map(
    lastMessages.map((message) => [message.threadId, message]),
  );

  // Não-lidas de todas as conversas da página em UMA query agregada (nunca
  // N+1): inbound gravada depois da última leitura do dono.
  const unreadRows = await db
    .select({ threadId: emailMessages.threadId, unreadCount: count() })
    .from(emailMessages)
    .innerJoin(emailThreads, eq(emailThreads.id, emailMessages.threadId))
    .where(and(inArray(emailMessages.threadId, ids), unseenInboundFilter))
    .groupBy(emailMessages.threadId);
  const unreadByThread = new Map(
    unreadRows.map((row) => [row.threadId, row.unreadCount]),
  );

  return rows.map((row) => {
    const last = byThread.get(row.id) ?? null;
    return {
      ...row,
      lastMessageAt: last?.createdAt ?? null,
      lastMessageDirection:
        last?.direction === "inbound" || last?.direction === "outbound"
          ? last.direction
          : null,
      lastMessageSnippet: last?.snippet ?? null,
      unreadCount: unreadByThread.get(row.id) ?? 0,
    };
  });
}

export interface EmailThreadMessage {
  id: string;
  direction: "inbound" | "outbound";
  fromAddress: string;
  fromName: string | null;
  toAddresses: string[];
  ccAddresses: string[];
  subject: string;
  textBody: string;
  htmlBody: string | null;
  snippet: string;
  attachments: EmailAttachmentRef[];
  /** Só significa algo na outbound: 'queued' | 'sent' | 'failed'. */
  status: string;
  errorDetail: string | null;
  createdAt: Date;
  sentAt: Date | null;
}

const threadMessageColumns = {
  id: emailMessages.id,
  direction: emailMessages.direction,
  fromAddress: emailMessages.fromAddress,
  fromName: emailMessages.fromName,
  toAddresses: emailMessages.toAddresses,
  ccAddresses: emailMessages.ccAddresses,
  subject: emailMessages.subject,
  textBody: emailMessages.textBody,
  htmlBody: emailMessages.htmlBody,
  snippet: emailMessages.snippet,
  attachments: emailMessages.attachments,
  status: emailMessages.status,
  errorDetail: emailMessages.errorDetail,
  createdAt: emailMessages.createdAt,
  sentAt: emailMessages.sentAt,
};

type ThreadMessageRow = Pick<
  typeof emailMessages.$inferSelect,
  keyof typeof threadMessageColumns
>;

function toThreadMessage(row: ThreadMessageRow): EmailThreadMessage {
  return {
    ...row,
    direction: row.direction === "inbound" ? "inbound" : "outbound",
    toAddresses: addressListSchema.parse(row.toAddresses),
    ccAddresses: addressListSchema.parse(row.ccAddresses),
    attachments: attachmentRefsSchema.parse(row.attachments),
  };
}

export interface EmailThreadDetail {
  thread: {
    id: string;
    subject: string;
    participantEmail: string;
    participantName: string | null;
    customerId: string | null;
    customerName: string | null;
    status: string;
    ownerLastSeenAt: Date | null;
    createdAt: Date;
  };
  messages: EmailThreadMessage[];
}

export async function getEmailThread(
  db: DbOrTx,
  threadId: string,
): Promise<EmailThreadDetail | null> {
  const [thread] = await db
    .select({
      id: emailThreads.id,
      subject: emailThreads.subject,
      participantEmail: emailThreads.participantEmail,
      participantName: emailThreads.participantName,
      customerId: emailThreads.customerId,
      customerName: customers.fullName,
      status: emailThreads.status,
      ownerLastSeenAt: emailThreads.ownerLastSeenAt,
      createdAt: emailThreads.createdAt,
    })
    .from(emailThreads)
    .leftJoin(customers, eq(customers.id, emailThreads.customerId))
    .where(eq(emailThreads.id, threadId))
    .limit(1);
  if (!thread) return null;

  // Tie-break por id: resposta e evento nascem na mesma transação com
  // created_at idêntico — sem ele a ordem oscilaria entre leituras.
  const rows = await db
    .select(threadMessageColumns)
    .from(emailMessages)
    .where(eq(emailMessages.threadId, threadId))
    .orderBy(asc(emailMessages.createdAt), asc(emailMessages.id));

  return { thread, messages: rows.map(toThreadMessage) };
}

export interface EmailThreadTail {
  thread: {
    id: string;
    status: string;
    ownerLastSeenAt: Date | null;
  };
  messages: EmailThreadMessage[];
}

const threadTailSchema = z.object({
  threadId: z.uuid(),
  limit: z.number().int().min(1).max(100).default(30),
});

/**
 * Últimas N mensagens da conversa para o poll da tela (o cliente faz upsert por
 * id, então a mesma resposta cobre mensagem nova E mudança de status do envio).
 */
export async function getEmailThreadTail(
  db: DbOrTx,
  input: z.input<typeof threadTailSchema>,
): Promise<EmailThreadTail | null> {
  const parsed = threadTailSchema.parse(input);

  const [thread] = await db
    .select({
      id: emailThreads.id,
      status: emailThreads.status,
      ownerLastSeenAt: emailThreads.ownerLastSeenAt,
    })
    .from(emailThreads)
    .where(eq(emailThreads.id, parsed.threadId))
    .limit(1);
  if (!thread) return null;

  const rows = await db
    .select(threadMessageColumns)
    .from(emailMessages)
    .where(eq(emailMessages.threadId, parsed.threadId))
    .orderBy(desc(emailMessages.createdAt), desc(emailMessages.id))
    .limit(parsed.limit);
  rows.reverse();

  return { thread, messages: rows.map(toThreadMessage) };
}

const threadIdSchema = z.object({ threadId: z.uuid() });

/**
 * Telemetria de leitura do painel: registra que o dono viu a conversa agora.
 * NÃO audita e aceita conversa arquivada — ler não é ação de atendimento.
 * (updated_at sobe junto por causa do trigger da tabela; é por isso que a
 * lista ordena por atividade, e não por updated_at.)
 */
export async function markThreadSeen(
  db: DbOrTx,
  input: z.input<typeof threadIdSchema>,
): Promise<{ seenAt: Date }> {
  const parsed = threadIdSchema.parse(input);
  const seenAt = new Date();

  const updated = await db
    .update(emailThreads)
    .set({ ownerLastSeenAt: seenAt })
    .where(eq(emailThreads.id, parsed.threadId))
    .returning({ id: emailThreads.id });
  if (updated.length === 0) {
    throw new ServiceError("thread_inexistente", "Conversa não encontrada.");
  }
  return { seenAt };
}

/**
 * Badge da sidebar: conversas abertas com inbound ainda não vista — apaga ao
 * ler e reacende com e-mail novo.
 */
export async function countThreadsAwaiting(db: DbOrTx): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(emailThreads)
    .where(
      and(
        eq(emailThreads.status, "open"),
        exists(
          db
            .select({ one: sql`1` })
            .from(emailMessages)
            .where(
              and(
                eq(emailMessages.threadId, emailThreads.id),
                unseenInboundFilter,
              ),
            ),
        ),
      ),
    );
  return row?.value ?? 0;
}

// ---------------------------------------------------------------------------
// Ações do dono
// ---------------------------------------------------------------------------

async function loadThreadForAction(db: DbOrTx, threadId: string) {
  const [thread] = await db
    .select({
      id: emailThreads.id,
      threadKey: emailThreads.threadKey,
      subject: emailThreads.subject,
      participantEmail: emailThreads.participantEmail,
      status: emailThreads.status,
    })
    .from(emailThreads)
    .where(eq(emailThreads.id, threadId))
    .limit(1);
  if (!thread) {
    throw new ServiceError("thread_inexistente", "Conversa não encontrada.");
  }
  return thread;
}

const actorSchema = threadIdSchema.extend({ userId: z.uuid() });

/** Arquivar tira a conversa da caixa de entrada; nada é apagado. */
export async function archiveThread(
  db: DbOrTx,
  input: z.input<typeof actorSchema>,
): Promise<{ status: "archived" }> {
  const parsed = actorSchema.parse(input);
  const thread = await loadThreadForAction(db, parsed.threadId);
  if (thread.status === "archived") return { status: "archived" };

  await db
    .update(emailThreads)
    .set({ status: "archived" })
    .where(eq(emailThreads.id, thread.id));
  await db.insert(auditLog).values({
    actorType: "user",
    actorId: parsed.userId,
    action: "email.thread_archive",
    entityType: "email_thread",
    entityId: thread.id,
    before: { status: thread.status },
    after: { status: "archived" },
  });
  return { status: "archived" };
}

export async function reopenThread(
  db: DbOrTx,
  input: z.input<typeof actorSchema>,
): Promise<{ status: "open" }> {
  const parsed = actorSchema.parse(input);
  const thread = await loadThreadForAction(db, parsed.threadId);
  if (thread.status === "open") return { status: "open" };

  // Enquanto a conversa estava arquivada, um e-mail novo pode ter aberto outra
  // com a MESMA thread_key (o unique parcial só vale entre as não-arquivadas).
  // Reabrir esta violaria o índice: avisamos em vez de estourar erro de banco.
  const [conflicting] = await db
    .select({ id: emailThreads.id })
    .from(emailThreads)
    .where(
      and(
        eq(emailThreads.threadKey, thread.threadKey),
        ne(emailThreads.status, "archived"),
      ),
    )
    .limit(1);
  if (conflicting) {
    throw new ServiceError(
      "thread_duplicada",
      "Já existe uma conversa aberta com este mesmo assunto e remetente.",
    );
  }

  await db
    .update(emailThreads)
    .set({ status: "open" })
    .where(eq(emailThreads.id, thread.id));
  await db.insert(auditLog).values({
    actorType: "user",
    actorId: parsed.userId,
    action: "email.thread_reopen",
    entityType: "email_thread",
    entityId: thread.id,
    before: { status: thread.status },
    after: { status: "open" },
  });
  return { status: "open" };
}

const sendEmailReplySchema = actorSchema.extend({
  body: z
    .string()
    .trim()
    .min(1, "Escreva a mensagem antes de enviar.")
    .max(10000, "A mensagem deve ter no máximo 10000 caracteres."),
});

/**
 * Resposta do dono: grava a linha 'queued' e enfileira 'email.send' na MESMA
 * transação (regra de ouro 5 — nada de envio inline). O dedupe_key da linha é
 * o mesmo do evento: retry da fila reaproveita a linha, nunca cria uma segunda.
 */
export async function sendEmailReply(
  db: DbOrTx,
  input: z.input<typeof sendEmailReplySchema>,
): Promise<{ queued: true; emailMessageId: string }> {
  const parsed = sendEmailReplySchema.parse(input);

  return db.transaction(async (tx) => {
    const thread = await loadThreadForAction(tx, parsed.threadId);
    if (thread.status === "archived") {
      throw new ServiceError(
        "thread_arquivada",
        "Esta conversa está arquivada. Reabra antes de responder.",
      );
    }

    const [lastInbound] = await tx
      .select({
        messageId: emailMessages.messageId,
        referencesIds: emailMessages.referencesIds,
      })
      .from(emailMessages)
      .where(
        and(
          eq(emailMessages.threadId, thread.id),
          eq(emailMessages.direction, "inbound"),
        ),
      )
      .orderBy(desc(emailMessages.createdAt), desc(emailMessages.id))
      .limit(1);

    // Cabeçalhos montados AQUI, no clique, e não na fila: é o que faz a
    // resposta encaixar na conversa do cliente, e um problema com eles precisa
    // aparecer para quem está na tela.
    const parentMessageId = normalizeMessageId(lastInbound?.messageId);
    const headers = parentMessageId
      ? buildReplyHeaders({
          messageId: parentMessageId,
          references: messageIdListSchema.parse(lastInbound?.referencesIds ?? []),
        })
      : null;

    const emailMessageId = randomUUID();
    // Uma resposta = uma linha, para sempre: o UNIQUE de dedupe_key é o árbitro
    // e o evento da fila carrega a mesma chave.
    const dedupeKey = `email.reply:${emailMessageId}`;

    await tx.insert(emailMessages).values({
      id: emailMessageId,
      threadId: thread.id,
      direction: "outbound",
      // O Message-ID de saída quem gera é o provedor; o id dele fica em
      // provider_message_id quando o envio acontece.
      messageId: null,
      inReplyTo: parentMessageId,
      // Guardamos exatamente a cadeia que vai no cabeçalho (o core trunca
      // cadeia longa por causa do limite de linha da RFC 5322).
      referencesIds: headers ? messageIdsFromHeader(headers.References) : [],
      fromAddress: ownFromAddress(),
      toAddresses: [thread.participantEmail],
      subject: replySubject(thread.subject),
      textBody: parsed.body,
      snippet: buildSnippet(parsed.body),
      dedupeKey,
      status: "queued",
    });

    await enqueueOutboxEvent(tx, {
      eventType: "email.send",
      dedupeKey,
      aggregateType: "email_thread",
      aggregateId: thread.id,
      payload: { emailMessageId },
    });

    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: parsed.userId,
      action: "email.reply_queued",
      entityType: "email_message",
      entityId: emailMessageId,
      after: { threadId: thread.id, to: thread.participantEmail },
    });

    return { queued: true, emailMessageId } as const;
  });
}

// ---------------------------------------------------------------------------
// Envio (chamado pelo handler 'email.send')
// ---------------------------------------------------------------------------

const sendQueuedEmailSchema = z.object({ emailMessageId: z.uuid() });

export type SendQueuedEmailResult =
  | { sent: true; providerMessageId: string }
  | { skipped: "ja_enviado" | "email_nao_configurado" };

/**
 * Cópia RFC 822 da resposta para a pasta "Enviados" da caixa do dono — sem
 * ela, ele abre o e-mail dele e vê só metade da conversa. Corpo em base64
 * porque acento em 8bit chega torto em servidor antigo.
 */
function buildSentCopy(input: {
  from: string;
  to: string;
  subject: string;
  text: string;
  headers: Record<string, string>;
  sentAt: Date;
}): string {
  // Cabeçalho só aceita ASCII imprimível: acento vira encoded-word (RFC 2047),
  // senão o assunto chega quebrado na pasta de enviados.
  const encodeHeader = (value: string): string =>
    /^[\x20-\x7e]*$/.test(value)
      ? value
      : `=?utf-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;

  const lines = [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${encodeHeader(input.subject)}`,
    // RFC 5322 aceita "+0000"; "GMT" (o que toUTCString devolve) é forma obsoleta.
    `Date: ${input.sentAt.toUTCString().replace(/GMT$/, "+0000")}`,
    ...Object.entries(input.headers).map(([key, value]) => `${key}: ${value}`),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
  ];
  const body = Buffer.from(input.text, "utf8")
    .toString("base64")
    .replace(/(.{76})/g, "$1\r\n");
  return `${lines.join("\r\n")}\r\n\r\n${body}\r\n`;
}

/**
 * Entrega a resposta já gravada como 'queued'. Idempotente no retry: linha já
 * 'sent' é pulada (o dedupe_key UNIQUE garante que só existe uma). Falha REAL
 * do provedor marca 'failed' e RELANÇA — retry/backoff/DLQ da fila cuidam.
 */
export async function sendQueuedEmail(
  db: DbOrTx,
  emailProvider: EmailProvider,
  mailbox: MailboxProvider,
  input: z.input<typeof sendQueuedEmailSchema>,
): Promise<SendQueuedEmailResult> {
  const parsed = sendQueuedEmailSchema.parse(input);

  const [message] = await db
    .select({
      id: emailMessages.id,
      threadId: emailMessages.threadId,
      inReplyTo: emailMessages.inReplyTo,
      referencesIds: emailMessages.referencesIds,
      fromAddress: emailMessages.fromAddress,
      toAddresses: emailMessages.toAddresses,
      subject: emailMessages.subject,
      textBody: emailMessages.textBody,
      status: emailMessages.status,
      participantEmail: emailThreads.participantEmail,
    })
    .from(emailMessages)
    .innerJoin(emailThreads, eq(emailThreads.id, emailMessages.threadId))
    .where(eq(emailMessages.id, parsed.emailMessageId))
    .limit(1);
  if (!message) {
    throw new ServiceError(
      "mensagem_inexistente",
      `Mensagem de e-mail ${parsed.emailMessageId} não encontrada.`,
    );
  }
  if (message.status === "sent") return { skipped: "ja_enviado" };

  // Sem canal de e-mail configurado a linha fica 'queued', visível no painel
  // como "na fila" — nada de falhar em loop a cada reentrega do evento.
  if (!isEmailConfigured()) return { skipped: "email_nao_configurado" };

  const to =
    addressListSchema.parse(message.toAddresses)[0] ?? message.participantEmail;
  // A LINHA é a fonte de verdade dos cabeçalhos: o retry remonta exatamente o
  // mesmo In-Reply-To/References que a primeira tentativa usou.
  const parentMessageId = normalizeMessageId(message.inReplyTo);
  const headers = parentMessageId
    ? buildReplyHeaders({
        messageId: parentMessageId,
        references: messageIdListSchema.parse(message.referencesIds),
      })
    : null;
  const replyTo = inboxReplyToAddress();

  let providerMessageId: string;
  try {
    ({ providerMessageId } = await emailProvider.send({
      to,
      subject: message.subject,
      html: bodyToHtml(message.textBody),
      text: message.textBody,
      ...(replyTo ? { replyTo } : {}),
      ...(headers ? { headers } : {}),
    }));
  } catch (error) {
    await db
      .update(emailMessages)
      .set({
        status: "failed",
        errorDetail: error instanceof Error ? error.message : String(error),
      })
      .where(eq(emailMessages.id, message.id));
    throw error;
  }

  const sentAt = new Date();
  await db
    .update(emailMessages)
    .set({ status: "sent", providerMessageId, sentAt, errorDetail: null })
    .where(eq(emailMessages.id, message.id));
  await db
    .update(emailThreads)
    .set({ lastOutboundAt: sentAt })
    .where(eq(emailThreads.id, message.threadId));

  try {
    await mailbox.appendToSent(
      buildSentCopy({
        from: message.fromAddress,
        to,
        subject: message.subject,
        text: message.textBody,
        headers: headers ?? {},
        sentAt,
      }),
    );
  } catch (error) {
    // Melhor esforço, e a ordem aqui é a regra: o e-mail JÁ saiu e a linha já
    // está 'sent'. Relançar faria o retry da fila mandar a MESMA resposta de
    // novo ao cliente só para consertar a cópia na pasta "Enviados".
    console.warn(
      `[email.send] cópia em "Enviados" falhou (mensagem ${message.id}).`,
      error,
    );
  }

  return { sent: true, providerMessageId };
}
