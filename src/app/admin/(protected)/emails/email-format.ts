// Formatação da caixa de e-mail: entra dado, sai texto para a tela. Puro de
// propósito (sem fetch, sem estado) — é o que dá para testar sem navegador,
// em tests/app/email-format.test.ts.
//
// Os formatadores são gêmeos dos de whatsapp/conversas/chat-format.ts, e isso
// é deliberado: são duas telas com rótulos próprios ("Você" x o nome da loja,
// hora curta x data por extenso). Um módulo compartilhado faria qualquer
// ajuste no chat mexer na caixa de e-mail sem ninguém pedir.
import { normalizeSubject } from "@/core/email/threading";

const TIME_ZONE = "America/Sao_Paulo";
const DAY_MS = 86_400_000;

/** Mesmo texto que o serviço grava quando o e-mail chega sem assunto. */
const DEFAULT_SUBJECT = "(sem assunto)";

// Criar Intl.DateTimeFormat é caro: uma instância por formato, no módulo.
const timeFormatter = new Intl.DateTimeFormat("pt-BR", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: TIME_ZONE,
});

// en-CA gera "aaaa-mm-dd": chave estável de dia para separadores.
const dayKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: TIME_ZONE,
});

const weekdayFormatter = new Intl.DateTimeFormat("pt-BR", {
  weekday: "long",
  timeZone: TIME_ZONE,
});

const shortDateFormatter = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  timeZone: TIME_ZONE,
});

const longDateFormatter = new Intl.DateTimeFormat("pt-BR", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: TIME_ZONE,
});

const oneDecimalFormatter = new Intl.NumberFormat("pt-BR", {
  maximumFractionDigits: 1,
});

/** Chave "aaaa-mm-dd" do dia em São Paulo — só para agrupar, nunca exibida. */
export function dayKeySP(iso: string): string {
  return dayKeyFormatter.format(new Date(iso));
}

/** Separador do dia na conversa: "Hoje", "Ontem" ou "26 de agosto de 2026". */
export function daySeparatorLabel(iso: string, now: Date = new Date()): string {
  const key = dayKeySP(iso);
  if (key === dayKeyFormatter.format(now)) return "Hoje";
  if (key === dayKeyFormatter.format(new Date(now.getTime() - DAY_MS))) {
    return "Ontem";
  }
  return longDateFormatter.format(new Date(iso));
}

/**
 * Data na lista: hoje → "14:32"; ontem → "ontem"; até uma semana atrás → dia
 * da semana; mais antigo → "26/08".
 */
export function listTimestamp(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const key = dayKeyFormatter.format(date);
  if (key === dayKeyFormatter.format(now)) return timeFormatter.format(date);
  if (key === dayKeyFormatter.format(new Date(now.getTime() - DAY_MS))) {
    return "ontem";
  }
  if (now.getTime() - date.getTime() < 7 * DAY_MS) {
    return weekdayFormatter.format(date);
  }
  return shortDateFormatter.format(date);
}

/**
 * Data no cabeçalho do e-mail aberto. Dia por extenso porque aqui o dono está
 * lendo uma mensagem só e a data completa é a informação útil.
 */
export function messageTimestamp(iso: string, now: Date = new Date()): string {
  return `${daySeparatorLabel(iso, now)} às ${timeFormatter.format(new Date(iso))}`;
}

/**
 * Como chamar quem escreveu: o nome do cliente cadastrado ganha do nome que
 * veio no cabeçalho do e-mail (aquele quem manda escolhe). Sem nenhum dos
 * dois, o próprio endereço — melhor do que inventar um apelido.
 */
export function senderLabel(input: {
  customerName?: string | null;
  participantName?: string | null;
  participantEmail: string;
}): string {
  const customer = input.customerName?.trim();
  if (customer) return customer;
  const participant = input.participantName?.trim();
  if (participant) return participant;
  const email = input.participantEmail.trim();
  return email || "Remetente desconhecido";
}

/** Iniciais do avatar: "Maria Silva" → "MS"; "maria.silva@x.com" → "MS". */
export function senderInitials(label: string): string {
  const cleaned = label.trim();
  if (cleaned === "") return "?";
  const local = cleaned.includes("@")
    ? (cleaned.split("@")[0] ?? "")
    : cleaned;
  const parts = local.split(/[\s._+-]+/).filter(Boolean);
  const first = parts[0]?.charAt(0) ?? "";
  const last =
    parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? "") : "";
  return (first + last).toUpperCase() || "?";
}

/** Assunto vazio nunca vira linha em branco na lista. */
export function subjectOrPlaceholder(subject: string): string {
  return subject.trim() || DEFAULT_SUBJECT;
}

/**
 * Esta mensagem trocou o assunto da conversa? Comparamos sem os "Re:"/"Enc:"
 * empilhados e sem diferença de maiúsculas, senão toda resposta pareceria um
 * assunto novo. Serve para o cartão só destacar o assunto quando ele mudou de
 * verdade — repeti-lo em todos seria ruído, já que ele está no cabeçalho.
 */
export function subjectChanged(
  messageSubject: string,
  threadSubject: string,
): boolean {
  const message = normalizeSubject(messageSubject);
  if (message === "") return false;
  return (
    message.toLocaleLowerCase("pt-BR") !==
    normalizeSubject(threadSubject).toLocaleLowerCase("pt-BR")
  );
}

/**
 * Assunto da resposta. Espelha `replySubject()` de services/email-inbox.ts de
 * propósito: é o serviço que decide o assunto real do e-mail, e o campo da
 * tela só mostra o que vai sair. Se os dois divergirem, a tela promete uma
 * coisa e o cliente recebe outra.
 */
export function replySubjectFor(subject: string): string {
  return `Re: ${normalizeSubject(subject) || DEFAULT_SUBJECT}`;
}

const KB = 1024;
const MB = KB * KB;

/** Tamanho do anexo em português: "820 bytes", "12,5 KB", "1,4 MB". */
export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "tamanho desconhecido";
  if (bytes < KB) return bytes === 1 ? "1 byte" : `${Math.round(bytes)} bytes`;
  if (bytes < MB) return `${oneDecimalFormatter.format(bytes / KB)} KB`;
  return `${oneDecimalFormatter.format(bytes / MB)} MB`;
}

/**
 * Quais conversas contam como "aguardando atendimento". No e-mail não existe
 * robô: pendente é conversa ainda na caixa (não arquivada) com mensagem que o
 * dono nunca abriu. Espelha o `countThreadsAwaiting()` do serviço — é o mesmo
 * número que o menu mostra no crachá e que o título da aba usa.
 */
export function isAwaitingReply(thread: {
  status: string;
  unreadCount: number;
}): boolean {
  return thread.status === "open" && thread.unreadCount > 0;
}

export function countAwaitingThreads(
  threads: ReadonlyArray<{ status: string; unreadCount: number }>,
): number {
  return threads.reduce(
    (total, thread) => (isAwaitingReply(thread) ? total + 1 : total),
    0,
  );
}
