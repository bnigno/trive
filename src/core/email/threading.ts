// Threading de e-mail (RFC 5322): dado o que veio nos cabeçalhos, em que
// conversa esta mensagem entra e quais cabeçalhos a nossa resposta precisa
// carregar. Puro: entra cabeçalho, sai string — sem relógio, sem sorteio, sem
// I/O. A mesma entrada devolve sempre a mesma chave, hoje e depois do deploy.

export class ThreadingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThreadingError";
  }
}

/** Chave derivada do Message-ID da raiz da conversa. */
const MESSAGE_ID_PREFIX = "mid:";

/** Chave derivada de assunto + participante (mensagem sem cabeçalho de thread). */
const SUBJECT_PREFIX = "sub:";

/**
 * Quantos Message-IDs cabem no References da resposta. RFC 5322 limita a linha
 * a 998 octetos e uma conversa longa estoura isso fácil — servidores chegam a
 * truncar o cabeçalho inteiro, e aí a resposta perde a conversa. Cortamos
 * mantendo a RAIZ (é ela que identifica a conversa) mais os mais recentes (são
 * eles que os clientes usam para pendurar a mensagem no lugar certo).
 */
const MAX_REFERENCES = 20;

// Prefixos de resposta/encaminhamento em pt-BR e en. `Re[2]:` é a variante com
// contador que alguns clientes empilham.
const REPLY_PREFIXES = /^\s*(?:(?:re|res|fwd|fw|enc)\s*(?:\[\d+\])?\s*:\s*)+/i;

// FNV-1a de 32 bits, aplicado com duas sementes para render 64 bits de chave.
// Não é criptográfico e não precisa ser: o requisito é ser ESTÁVEL entre
// processos e entre deploys — coisa que o hash interno de string do runtime
// não promete —, para a mesma conversa cair sempre na mesma chave.
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const FNV_SECOND_SEED = 0x7fb9d1e3;

function fnv1a(value: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

function stableHash(value: string): string {
  const first = fnv1a(value, FNV_OFFSET_BASIS).toString(16).padStart(8, "0");
  const second = fnv1a(value, FNV_SECOND_SEED).toString(16).padStart(8, "0");
  return `${first}${second}`;
}

/**
 * Message-ID sem os `<>` e sem espaço em volta; null quando não sobra nada.
 * Guardamos e comparamos sempre a forma NUA — os `<>` voltam só na hora de
 * escrever o cabeçalho. Exportada porque o adapter de caixa de entrada
 * normaliza o que vem do IMAP com ESTA função: se as duas pontas divergirem,
 * a mesma mensagem gera duas chaves de conversa.
 */
export function normalizeMessageId(value: string | null | undefined): string | null {
  const bare = (value ?? "")
    .trim()
    .replace(/^<+/, "")
    .replace(/>+$/, "")
    .trim();
  return bare.length > 0 ? bare : null;
}

/**
 * Assunto sem os prefixos de resposta/encaminhamento empilhados e sem espaço
 * sobrando. "Re: Re: Enc: Pedido  #12" → "Pedido #12".
 */
export function normalizeSubject(subject: string): string {
  return subject.replace(REPLY_PREFIXES, "").replace(/\s+/g, " ").trim();
}

export type ThreadKeyInput = {
  /**
   * Message-ID da própria mensagem. Faz parte do contrato de entrada, mas NÃO
   * entra na chave: quem manda é a raiz da conversa (veja `threadKeyFor`).
   */
  messageId: string;
  inReplyTo?: string;
  references: string[];
  subject: string;
  /** O outro lado da conversa (o cliente), não a nossa caixa. */
  participantEmail: string;
};

/**
 * Chave estável da conversa a que a mensagem pertence.
 *
 * Ordem das regras, e ela é contrato:
 * 1. raiz de `references` (o primeiro id da lista) → `mid:<id>`;
 * 2. senão `inReplyTo` → `mid:<id>`;
 * 3. senão hash de assunto normalizado + participante → `sub:<hash>`.
 *
 * ATENÇÃO para quem consome: a PRIMEIRA mensagem de uma conversa não tem
 * cabeçalho de thread nenhum e cai na regra 3, enquanto as respostas dela caem
 * na regra 1 com `mid:<id-da-primeira>`. As duas chaves são diferentes de
 * propósito — para juntar as duas pontas, o service deve procurar primeiro uma
 * conversa que já tenha uma mensagem com aquele `messageId` (o prefixo `mid:`
 * diz quando vale a pena procurar) e só então cair na chave.
 */
export function threadKeyFor(input: ThreadKeyInput): string {
  for (const reference of input.references) {
    const root = normalizeMessageId(reference);
    if (root) return `${MESSAGE_ID_PREFIX}${root}`;
  }

  const parent = normalizeMessageId(input.inReplyTo);
  if (parent) return `${MESSAGE_ID_PREFIX}${parent}`;

  // Sem participante no meio do hash, duas pessoas com o mesmo assunto
  // ("Dúvida sobre o pedido") cairiam na mesma conversa.
  const subject = normalizeSubject(input.subject).toLowerCase();
  const participant = input.participantEmail.trim().toLowerCase();
  // Separador de linha: o assunto normalizado nunca tem quebra de linha, então
  // nenhum par (assunto, e-mail) diferente consegue produzir a mesma string.
  return `${SUBJECT_PREFIX}${stableHash(`${subject}\n${participant}`)}`;
}

export type BuildReplyHeadersInput = {
  /** Message-ID da mensagem que estamos RESPONDENDO. */
  messageId: string;
  /** References que essa mensagem trazia (da mais antiga para a mais nova). */
  references: string[];
};

export type ReplyHeaders = {
  "In-Reply-To": string;
  References: string;
};

/**
 * Cabeçalhos que a nossa resposta precisa levar para o cliente de e-mail do
 * cliente encaixá-la na conversa: In-Reply-To aponta a mensagem respondida e
 * References é a cadeia dela mais a própria mensagem respondida (RFC 5322
 * §3.6.4).
 */
export function buildReplyHeaders(input: BuildReplyHeadersInput): ReplyHeaders {
  const parent = normalizeMessageId(input.messageId);
  if (!parent) {
    throw new ThreadingError(
      "Mensagem sem Message-ID: não há como montar os cabeçalhos de resposta.",
    );
  }

  const chain: string[] = [];
  for (const reference of [...input.references, parent]) {
    const id = normalizeMessageId(reference);
    if (id && !chain.includes(id)) chain.push(id);
  }

  const trimmed =
    chain.length <= MAX_REFERENCES
      ? chain
      : [chain[0], ...chain.slice(chain.length - (MAX_REFERENCES - 1))];

  return {
    "In-Reply-To": `<${parent}>`,
    References: trimmed.map((id) => `<${id}>`).join(" "),
  };
}
