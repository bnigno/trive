// Caixa de entrada de e-mail (Fase 6): ingestão idempotente do que chega pelo
// IMAP, agrupamento em conversas (o core decide a chave), não-lidas pela marca
// d'água e resposta do dono — que ENFILEIRA e nunca envia inline, com o envio
// idempotente no retry da fila.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EmailProvider } from "@/adapters/email";
import { FakeEmailProvider } from "@/adapters/email/fake";
import { FakeMailboxProvider } from "@/adapters/mailbox/fake";
import { FakeFileStorage } from "@/adapters/storage/fake";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import {
  archiveThread,
  countThreadsAwaiting,
  getEmailThread,
  getEmailThreadTail,
  ingestInboundEmail,
  listEmailThreads,
  markThreadSeen,
  pollEmailInbox,
  reopenThread,
  sendEmailReply,
  sendQueuedEmail,
  type IngestInboundEmailInput,
} from "@/services/email-inbox";
import { createTestDb, FIXED_USER_ID, type TestDb } from "../helpers/db";

describe("email-inbox (caixa de entrada do painel)", () => {
  let db: TestDb;
  let sdb: DbOrTx;
  let close: () => Promise<void>;
  let storage: FakeFileStorage;
  let mailbox: FakeMailboxProvider;
  let emailProvider: FakeEmailProvider;
  let uidSequence: number;

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    sdb = db as unknown as DbOrTx;
    storage = new FakeFileStorage();
    mailbox = new FakeMailboxProvider();
    emailProvider = new FakeEmailProvider();
    uidSequence = 0;
  });

  afterEach(async () => {
    await close();
  });

  function inbound(
    overrides: Partial<IngestInboundEmailInput> = {},
  ): IngestInboundEmailInput {
    uidSequence += 1;
    return {
      uid: uidSequence,
      messageId: `msg-${uidSequence}@cliente.com`,
      references: [],
      from: { address: "ana@cliente.com", name: "Ana Compradora" },
      to: ["contato@trivemaison.com.br"],
      cc: [],
      subject: "Dúvida sobre o pedido",
      textBody: "Oi! Meu pedido já saiu para entrega?",
      attachments: [],
      receivedAt: new Date("2026-08-20T10:00:00Z"),
      ...overrides,
    };
  }

  async function ingest(overrides: Partial<IngestInboundEmailInput> = {}) {
    return ingestInboundEmail(sdb, storage, inbound(overrides));
  }

  // -------------------------------------------------------------------------
  // Ingestão
  // -------------------------------------------------------------------------

  it("ingestão cria a conversa e a mensagem, com prévia e vínculo ao cliente conhecido", async () => {
    const [customer] = await db
      .insert(schema.customers)
      .values({ fullName: "Ana Compradora", email: "ana@cliente.com" })
      .returning({ id: schema.customers.id });

    const result = await ingest();
    expect(result.action).toBe("ingested");

    const threads = await db.select().from(schema.emailThreads);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      subject: "Dúvida sobre o pedido",
      participantEmail: "ana@cliente.com",
      participantName: "Ana Compradora",
      customerId: customer.id,
      status: "open",
      ownerLastSeenAt: null,
    });
    expect(threads[0].lastInboundAt).not.toBeNull();

    const messages = await db.select().from(schema.emailMessages);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      direction: "inbound",
      messageId: "msg-1@cliente.com",
      fromAddress: "ana@cliente.com",
      snippet: "Oi! Meu pedido já saiu para entrega?",
      imapUid: 1,
    });

    // O evento inbound é o árbitro da idempotência e fica concluído.
    const events = await db.select().from(schema.inboundEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: "email",
      externalEventId: "msg-1@cliente.com",
      status: "done",
    });
  });

  it("reentrega do MESMO Message-ID não duplica nada", async () => {
    const email = inbound();
    const first = await ingestInboundEmail(sdb, storage, email);
    const second = await ingestInboundEmail(sdb, storage, email);

    expect(first.action).toBe("ingested");
    expect(second).toEqual({ action: "duplicate" });
    expect(await db.select().from(schema.emailThreads)).toHaveLength(1);
    expect(await db.select().from(schema.emailMessages)).toHaveLength(1);
    expect(await db.select().from(schema.inboundEvents)).toHaveLength(1);
  });

  it("resposta a um e-mail existente cai na MESMA conversa (chave 'sub:' e 'mid:' se juntam pelo pai)", async () => {
    const first = await ingest();
    expect(first.action).toBe("ingested");
    if (first.action !== "ingested") return;

    const reply = await ingest({
      subject: "Re: Dúvida sobre o pedido",
      inReplyTo: "msg-1@cliente.com",
      references: ["msg-1@cliente.com"],
      textBody: "Consegue confirmar?",
      receivedAt: new Date("2026-08-20T11:00:00Z"),
    });
    expect(reply).toMatchObject({ action: "ingested", threadId: first.threadId });

    expect(await db.select().from(schema.emailThreads)).toHaveLength(1);
    const thread = await getEmailThread(sdb, first.threadId);
    expect(thread!.messages.map((message) => message.textBody)).toEqual([
      "Oi! Meu pedido já saiu para entrega?",
      "Consegue confirmar?",
    ]);
  });

  it("assuntos IGUAIS de remetentes diferentes NÃO colidem", async () => {
    const fromAna = await ingest();
    const fromBruno = await ingest({
      from: { address: "bruno@cliente.com" },
      messageId: "msg-bruno@cliente.com",
    });

    expect(fromAna.action).toBe("ingested");
    expect(fromBruno.action).toBe("ingested");
    if (fromAna.action !== "ingested" || fromBruno.action !== "ingested") return;
    expect(fromAna.threadId).not.toBe(fromBruno.threadId);

    const list = await listEmailThreads(sdb);
    expect(list).toHaveLength(2);
    expect(list.map((item) => item.participantEmail).sort()).toEqual([
      "ana@cliente.com",
      "bruno@cliente.com",
    ]);
  });

  it("anexo vai para o storage e a mensagem guarda caminho, tipo e tamanho", async () => {
    const result = await ingest({
      attachments: [
        {
          filename: "nota fiscal.pdf",
          contentType: "application/pdf",
          content: new Uint8Array([1, 2, 3, 4]),
        },
      ],
    });
    expect(result.action).toBe("ingested");

    const paths = storage.list();
    expect(paths).toHaveLength(1);
    expect(paths[0]).toBe("emails/msg-1-cliente.com/1-nota-fiscal.pdf");
    expect(storage.get(paths[0])!.contentType).toBe("application/pdf");

    const [message] = await db.select().from(schema.emailMessages);
    expect(message.attachments).toEqual([
      {
        storagePath: paths[0],
        filename: "nota fiscal.pdf",
        contentType: "application/pdf",
        sizeBytes: 4,
      },
    ]);
  });

  // -------------------------------------------------------------------------
  // Não-lidas (marca d'água) e badge
  // -------------------------------------------------------------------------

  it("não-lidas contam pela marca d'água: ler zera, e-mail novo reacende", async () => {
    const first = await ingest();
    if (first.action !== "ingested") throw new Error("ingestão falhou");
    await ingest({
      inReplyTo: "msg-1@cliente.com",
      references: ["msg-1@cliente.com"],
      textBody: "Alô?",
    });

    expect((await listEmailThreads(sdb))[0].unreadCount).toBe(2);
    expect(await countThreadsAwaiting(sdb)).toBe(1);

    await markThreadSeen(sdb, { threadId: first.threadId });
    expect((await listEmailThreads(sdb))[0].unreadCount).toBe(0);
    expect(await countThreadsAwaiting(sdb)).toBe(0);

    // Mensagem nova nasce DEPOIS do "visto" (created_at é o relógio real).
    await ingest({
      inReplyTo: "msg-1@cliente.com",
      references: ["msg-1@cliente.com"],
      textBody: "Voltei",
    });
    expect((await listEmailThreads(sdb))[0].unreadCount).toBe(1);
    expect(await countThreadsAwaiting(sdb)).toBe(1);
  });

  it("resposta do dono NÃO conta como não-lida e a lista não reordena ao ler", async () => {
    const first = await ingest();
    if (first.action !== "ingested") throw new Error("ingestão falhou");

    await sendEmailReply(sdb, {
      threadId: first.threadId,
      userId: FIXED_USER_ID,
      body: "Já saiu sim!",
    });

    expect((await listEmailThreads(sdb))[0].unreadCount).toBe(1);

    const [before] = await db.select().from(schema.emailThreads);
    await markThreadSeen(sdb, { threadId: first.threadId });
    const [after] = await db.select().from(schema.emailThreads);
    // A ordenação da lista vem da ATIVIDADE (última mensagem), então ler não
    // muda a posição mesmo com o trigger mexendo em updated_at.
    expect(after.lastInboundAt?.getTime()).toBe(before.lastInboundAt?.getTime());
    expect(after.ownerLastSeenAt).not.toBeNull();
    // Ler não é ação de atendimento: sem trilha de auditoria.
    const audits = await db.select().from(schema.auditLog);
    expect(audits.map((audit) => audit.action)).toEqual(["email.reply_queued"]);
  });

  // -------------------------------------------------------------------------
  // Resposta do dono: enfileira, nunca envia inline
  // -------------------------------------------------------------------------

  it("sendEmailReply grava a linha 'queued', enfileira 'email.send' e NÃO envia inline", async () => {
    const first = await ingest();
    if (first.action !== "ingested") throw new Error("ingestão falhou");

    const result = await sendEmailReply(sdb, {
      threadId: first.threadId,
      userId: FIXED_USER_ID,
      body: "Oi, Ana! Seu pedido sai hoje.",
    });
    expect(result.queued).toBe(true);

    const [outbound] = await db
      .select()
      .from(schema.emailMessages)
      .where(eq(schema.emailMessages.id, result.emailMessageId));
    expect(outbound).toMatchObject({
      direction: "outbound",
      status: "queued",
      subject: "Re: Dúvida sobre o pedido",
      inReplyTo: "msg-1@cliente.com",
      messageId: null,
      providerMessageId: null,
      dedupeKey: `email.reply:${result.emailMessageId}`,
    });
    expect(outbound.referencesIds).toEqual(["msg-1@cliente.com"]);

    const outbox = await db.select().from(schema.outboxEvents);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      eventType: "email.send",
      aggregateType: "email_thread",
      aggregateId: first.threadId,
      dedupeKey: `email.reply:${result.emailMessageId}`,
      payload: { emailMessageId: result.emailMessageId },
    });

    // Regra de ouro 5: nada saiu pelo provedor dentro do request.
    expect(emailProvider.sentEmails).toHaveLength(0);

    const tail = await getEmailThreadTail(sdb, { threadId: first.threadId });
    expect(tail!.messages.map((message) => message.direction)).toEqual([
      "inbound",
      "outbound",
    ]);
  });

  it("responder conversa arquivada ou inexistente é recusado", async () => {
    const first = await ingest();
    if (first.action !== "ingested") throw new Error("ingestão falhou");
    await archiveThread(sdb, {
      threadId: first.threadId,
      userId: FIXED_USER_ID,
    });

    await expect(
      sendEmailReply(sdb, {
        threadId: first.threadId,
        userId: FIXED_USER_ID,
        body: "oi",
      }),
    ).rejects.toMatchObject({ code: "thread_arquivada" });

    await expect(
      sendEmailReply(sdb, {
        threadId: "00000000-0000-4000-8000-0000000000ff",
        userId: FIXED_USER_ID,
        body: "oi",
      }),
    ).rejects.toMatchObject({ code: "thread_inexistente" });
  });

  // -------------------------------------------------------------------------
  // Envio (o que o handler 'email.send' executa)
  // -------------------------------------------------------------------------

  async function queueReply(body = "Oi, Ana! Seu pedido sai hoje.") {
    const first = await ingest();
    if (first.action !== "ingested") throw new Error("ingestão falhou");
    const reply = await sendEmailReply(sdb, {
      threadId: first.threadId,
      userId: FIXED_USER_ID,
      body,
    });
    return { threadId: first.threadId, emailMessageId: reply.emailMessageId };
  }

  it("email.send envia uma vez, threadeia a resposta e é idempotente no retry", async () => {
    const { threadId, emailMessageId } = await queueReply();

    const sent = await sendQueuedEmail(sdb, emailProvider, mailbox, {
      emailMessageId,
    });
    expect(sent).toEqual({ sent: true, providerMessageId: "fake-email-1" });

    expect(emailProvider.sentEmails).toHaveLength(1);
    expect(emailProvider.sentEmails[0]).toMatchObject({
      to: "ana@cliente.com",
      subject: "Re: Dúvida sobre o pedido",
      text: "Oi, Ana! Seu pedido sai hoje.",
      headers: {
        "In-Reply-To": "<msg-1@cliente.com>",
        References: "<msg-1@cliente.com>",
      },
    });
    // Cópia na pasta "Enviados": sem ela o dono vê meia conversa no e-mail dele.
    expect(mailbox.appendedToSent).toHaveLength(1);
    expect(mailbox.appendedToSent[0]).toContain("In-Reply-To: <msg-1@cliente.com>");

    const [message] = await db
      .select()
      .from(schema.emailMessages)
      .where(eq(schema.emailMessages.id, emailMessageId));
    expect(message).toMatchObject({
      status: "sent",
      providerMessageId: "fake-email-1",
      errorDetail: null,
    });
    expect(message.sentAt).not.toBeNull();

    const [thread] = await db
      .select()
      .from(schema.emailThreads)
      .where(eq(schema.emailThreads.id, threadId));
    expect(thread.lastOutboundAt).not.toBeNull();

    // Reentrega do MESMO evento (retry/varredura): não manda de novo.
    const retry = await sendQueuedEmail(sdb, emailProvider, mailbox, {
      emailMessageId,
    });
    expect(retry).toEqual({ skipped: "ja_enviado" });
    expect(emailProvider.sentEmails).toHaveLength(1);
    expect(mailbox.appendedToSent).toHaveLength(1);
  });

  it("falha do provedor marca 'failed' e RELANÇA; o retry envia a mesma linha", async () => {
    const { emailMessageId } = await queueReply();
    const brokenProvider: EmailProvider = {
      async send() {
        throw new Error("Falha ao enviar e-mail via Resend (HTTP 500).");
      },
    };

    await expect(
      sendQueuedEmail(sdb, brokenProvider, mailbox, { emailMessageId }),
    ).rejects.toThrow("HTTP 500");

    const [failed] = await db
      .select()
      .from(schema.emailMessages)
      .where(eq(schema.emailMessages.id, emailMessageId));
    expect(failed.status).toBe("failed");
    expect(failed.errorDetail).toContain("HTTP 500");

    const retried = await sendQueuedEmail(sdb, emailProvider, mailbox, {
      emailMessageId,
    });
    expect(retried).toEqual({ sent: true, providerMessageId: "fake-email-1" });
    // Uma linha só, do começo ao fim — nunca uma segunda resposta ao cliente.
    expect(
      await db.select().from(schema.emailMessages).where(eq(schema.emailMessages.direction, "outbound")),
    ).toHaveLength(1);
  });

  it("cópia em 'Enviados' é melhor esforço: falhar nela NÃO reprova o envio", async () => {
    const { emailMessageId } = await queueReply();
    mailbox.failNext("appendToSent", "indisponivel");

    const sent = await sendQueuedEmail(sdb, emailProvider, mailbox, {
      emailMessageId,
    });
    expect(sent).toMatchObject({ sent: true });

    const [message] = await db
      .select()
      .from(schema.emailMessages)
      .where(eq(schema.emailMessages.id, emailMessageId));
    expect(message.status).toBe("sent");
    expect(mailbox.appendedToSent).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Arquivar / reabrir
  // -------------------------------------------------------------------------

  it("arquivar tira da caixa de entrada; reabrir devolve, e o histórico fica", async () => {
    const first = await ingest();
    if (first.action !== "ingested") throw new Error("ingestão falhou");

    await archiveThread(sdb, { threadId: first.threadId, userId: FIXED_USER_ID });
    expect(await listEmailThreads(sdb)).toHaveLength(0);
    expect(await listEmailThreads(sdb, { status: "archived" })).toHaveLength(1);
    expect(await countThreadsAwaiting(sdb)).toBe(0);

    await reopenThread(sdb, { threadId: first.threadId, userId: FIXED_USER_ID });
    expect(await listEmailThreads(sdb)).toHaveLength(1);

    const audits = await db.select().from(schema.auditLog);
    expect(audits.map((audit) => audit.action)).toEqual([
      "email.thread_archive",
      "email.thread_reopen",
    ]);
  });

  it("resposta a conversa arquivada abre uma conversa NOVA (a arquivada não volta sozinha)", async () => {
    const first = await ingest();
    if (first.action !== "ingested") throw new Error("ingestão falhou");
    await archiveThread(sdb, { threadId: first.threadId, userId: FIXED_USER_ID });

    const reply = await ingest({
      subject: "Re: Dúvida sobre o pedido",
      inReplyTo: "msg-1@cliente.com",
      references: ["msg-1@cliente.com"],
      textBody: "Continuo esperando",
    });
    expect(reply.action).toBe("ingested");
    if (reply.action !== "ingested") return;
    expect(reply.threadId).not.toBe(first.threadId);

    const open = await listEmailThreads(sdb);
    expect(open.map((item) => item.id)).toEqual([reply.threadId]);
  });

  // -------------------------------------------------------------------------
  // Cron de recebimento
  // -------------------------------------------------------------------------

  it("poll lê a partir do maior imap_uid, marca como lida e não reprocessa", async () => {
    mailbox.seed({ from: "ana@cliente.com", subject: "Primeira" });
    mailbox.seed({ from: "bruno@cliente.com", subject: "Segunda" });

    const first = await pollEmailInbox(sdb, mailbox, storage);
    expect(first).toEqual({ fetched: 2, ingested: 2, duplicates: 0, lastUid: 2 });
    expect(mailbox.seenUids).toEqual([1, 2]);

    // Sem novidade na caixa, a rodada seguinte não traz (nem regrava) nada.
    const idle = await pollEmailInbox(sdb, mailbox, storage);
    expect(idle).toMatchObject({ fetched: 0, ingested: 0, lastUid: 2 });

    mailbox.seed({ from: "ana@cliente.com", subject: "Terceira" });
    const third = await pollEmailInbox(sdb, mailbox, storage);
    expect(third).toMatchObject({ fetched: 1, ingested: 1, lastUid: 3 });
    expect(await db.select().from(schema.emailMessages)).toHaveLength(3);
  });
});
