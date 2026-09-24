// A entrevista da curadora: uma vez por dia a Lia faz UMA pergunta sobre UMA
// peça no WhatsApp da dona; a resposta em áudio vira a nota da curadora e
// duas legendas. PURO — qual peça, qual pergunta, quando perguntar, quando
// recuar e o que a resposta da dona quer dizer.
import { z } from "zod";

import { fitCuratorNote } from "@/core/catalog/curator-note";
import type { PieceType } from "@/core/catalog/piece-types";

/** A resposta vale até 8 h depois da pergunta (10h → 18h); depois disso o áudio volta a ir para a Lia. */
export const INTERVIEW_ANSWER_WINDOW_MS = 8 * 60 * 60 * 1000;
/** O rascunho espera o "ok" por 24 h. */
export const INTERVIEW_DRAFT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** A mesma peça não volta a ser perguntada antes de 14 dias. */
export const INTERVIEW_PRODUCT_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;
/** Tantas perguntas seguidas sem resposta (pulou ou deixou passar) → só uma por semana. */
export const INTERVIEW_BACKOFF_AFTER = 3;
/** Segunda-feira (0 = domingo): o dia da pergunta no modo semanal. */
export const INTERVIEW_WEEKLY_DAY = 1;
export const INTERVIEW_HOUR_MIN = 9;
export const INTERVIEW_HOUR_MAX = 20;
export const INTERVIEW_HOUR_DEFAULT = 10;

export const INTERVIEW_STATUSES = ["asked", "drafting", "draft_sent", "approved", "skipped", "expired", "failed"] as const;
export type InterviewStatus = (typeof INTERVIEW_STATUSES)[number];
/** Abertas: a dona ainda pode responder ou aprovar. */
export const OPEN_INTERVIEW_STATUSES = ["asked", "drafting", "draft_sent"] as const satisfies readonly InterviewStatus[];

export const QUESTION_KEYS = ["por_que", "onde_usar", "combina", "caimento", "sensacao"] as const;
export type QuestionKey = (typeof QUESTION_KEYS)[number];

/** Tipos de peça que não se vestem no corpo: caimento e sensação não fazem sentido. */
const ACCESSORY_TYPES: ReadonlySet<string> = new Set<PieceType>(["bolsa", "cinto", "brinco", "colar", "pulseira", "relogio", "oculos", "chapeu", "lenco"]);

export function questionKeysFor(pieceType: string | null): readonly QuestionKey[] {
  return pieceType && ACCESSORY_TYPES.has(pieceType)
    ? (["por_que", "onde_usar", "combina"] as const)
    : QUESTION_KEYS;
}

/** A pergunta, na voz da Lia, sobre a peça pelo nome. */
export function questionText(key: QuestionKey, productName: string): string {
  const name = productName.trim();
  switch (key) {
    case "por_que":
      return `Por que você escolheu trazer ${name} para a loja?`;
    case "onde_usar":
      return `Pra onde você usaria ${name}? Me conta a cena.`;
    case "combina":
      return `Com o que você combinaria ${name}?`;
    case "caimento":
      return `Como ${name} veste? Pra qual corpo ela fica mais bonita?`;
    case "sensacao":
      return `Como é ${name} no calor de Belém — o tecido, a sensação na pele?`;
  }
}

export type InterviewCandidate = {
  productId: string;
  name: string;
  pieceType: string | null;
  hasNote: boolean;
  inActiveEdition: boolean;
  createdAt: Date;
  /** Perguntas já feitas sobre esta peça (qualquer status). */
  askedKeys: readonly string[];
  lastAskedAt: Date | null;
};

export type InterviewTarget = { productId: string; productName: string; questionKey: QuestionKey; question: string };

/**
 * A peça e a pergunta de hoje: primeiro as da edição ativa ainda sem a voz
 * da dona, depois as outras sem nota, depois as que já têm nota (outras
 * perguntas) — dentro de cada grupo, a mais nova. Peça perguntada há menos
 * de 14 dias ou sem pergunta nova fica de fora; null = nada a perguntar.
 */
export function pickInterviewTarget(candidates: readonly InterviewCandidate[], now: Date): InterviewTarget | null {
  const tier = (candidate: InterviewCandidate): number =>
    !candidate.hasNote && candidate.inActiveEdition ? 0 : !candidate.hasNote ? 1 : 2;
  const eligible = candidates
    .filter((candidate) => candidate.name.trim() !== "")
    .filter((candidate) => !candidate.lastAskedAt || now.getTime() - candidate.lastAskedAt.getTime() >= INTERVIEW_PRODUCT_COOLDOWN_MS)
    .map((candidate) => ({ candidate, key: questionKeysFor(candidate.pieceType).find((key) => !candidate.askedKeys.includes(key)) }))
    .filter((entry): entry is { candidate: InterviewCandidate; key: QuestionKey } => entry.key !== undefined)
    .sort(
      (a, b) =>
        tier(a.candidate) - tier(b.candidate) ||
        b.candidate.createdAt.getTime() - a.candidate.createdAt.getTime() ||
        a.candidate.productId.localeCompare(b.candidate.productId),
    );
  const first = eligible[0];
  if (!first) return null;
  return {
    productId: first.candidate.productId,
    productName: first.candidate.name.trim(),
    questionKey: first.key,
    question: questionText(first.key, first.candidate.name),
  };
}

export type InterviewCadence = { mode: "daily" | "weekly" };

/**
 * Recuo: três perguntas seguidas sem resposta (puladas ou vencidas) e a
 * Lia passa a perguntar uma vez por semana, até a dona responder uma.
 * `recent` vem da mais nova para a mais velha.
 */
export function interviewCadence(recent: readonly { status: InterviewStatus }[]): InterviewCadence {
  const closed = recent.filter((row) => !(OPEN_INTERVIEW_STATUSES as readonly string[]).includes(row.status));
  let unanswered = 0;
  for (const row of closed) {
    if (row.status === "skipped" || row.status === "expired") unanswered += 1;
    else if (row.status === "approved") break;
    // "failed" (a inteligência caiu) não é culpa da dona: não conta nem zera.
    if (unanswered >= INTERVIEW_BACKOFF_AFTER) return { mode: "weekly" };
  }
  return { mode: "daily" };
}

export type AskWhenInput = {
  enabled: boolean;
  hour: number;
  weekends: boolean;
  /** Hora e dia da semana no relógio de São Paulo (0 = domingo). */
  spHour: number;
  spWeekday: number;
  cadence: InterviewCadence;
};

/** O cron roda de hora em hora: pergunta só na hora escolhida, nos dias certos. */
export function shouldAskNow(input: AskWhenInput): boolean {
  if (!input.enabled || input.spHour !== input.hour) return false;
  const weekend = input.spWeekday === 0 || input.spWeekday === 6;
  if (weekend && !input.weekends) return false;
  if (input.cadence.mode === "weekly") return input.spWeekday === INTERVIEW_WEEKLY_DAY;
  return true;
}

export function normalizeInterviewHour(value: unknown): number {
  const hour = typeof value === "number" ? value : Number(value);
  return Number.isInteger(hour) && hour >= INTERVIEW_HOUR_MIN && hour <= INTERVIEW_HOUR_MAX ? hour : INTERVIEW_HOUR_DEFAULT;
}

// ---------------------------------------------------------------------------
// O que a dona respondeu
// ---------------------------------------------------------------------------

export type InterviewReply =
  | { kind: "answer_audio" }
  | { kind: "answer_text"; text: string }
  | { kind: "approve"; withVoice: boolean }
  | { kind: "correct"; text: string }
  | { kind: "skip" };

function plain(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[!.?…]+$/u, "")
    .trim();
}

const SKIP_WORDS = new Set(["pula", "pular", "pulo", "amanha", "hoje nao", "nao sei", "depois", "agora nao"]);
const APPROVE_WORDS = new Set(["ok", "okay", "pode", "pode salvar", "salva", "sim", "aprovado", "perfeito", "👍"]);
const APPROVE_VOICE_WORDS = new Set(["ok voz", "ok com voz", "ok com a voz", "salva com voz", "voz"]);

/**
 * O que a mensagem da dona quer dizer para a entrevista aberta. Só o áudio
 * e as palavras combinadas contam — texto solto dela continua indo à Lia
 * (ela testa a vendedora como cliente). null = não é para a entrevista.
 */
export function classifyInterviewReply(input: {
  status: InterviewStatus;
  messageKind: "audio" | "text" | "image" | "note";
  body: string;
}): InterviewReply | null {
  if (input.messageKind === "image") return null;
  if (input.status === "drafting") return null;
  if (input.messageKind === "audio") {
    return input.status === "asked" || input.status === "draft_sent" ? { kind: "answer_audio" } : null;
  }
  const raw = input.body.trim();
  const text = plain(raw);
  if (SKIP_WORDS.has(text)) return input.status === "asked" || input.status === "draft_sent" ? { kind: "skip" } : null;
  const answer = /^resposta\s*:\s*/i.exec(raw);
  if (answer && (input.status === "asked" || input.status === "draft_sent")) {
    const rest = raw.slice(answer[0].length).trim();
    return rest ? { kind: "answer_text", text: rest } : null;
  }
  if (input.status !== "draft_sent") return null;
  if (APPROVE_VOICE_WORDS.has(text)) return { kind: "approve", withVoice: true };
  if (APPROVE_WORDS.has(text)) return { kind: "approve", withVoice: false };
  const correct = /^corrig[ea]\s*:\s*/i.exec(raw);
  if (correct) {
    const rest = raw.slice(correct[0].length).trim();
    return rest ? { kind: "correct", text: rest } : null;
  }
  return null;
}

/** Ainda dentro do prazo de resposta (pergunta) ou de aprovação (rascunho). */
export function isInterviewOpen(row: { status: InterviewStatus; askedAt: Date; draftSentAt: Date | null }, now: Date): boolean {
  if (row.status === "asked" || row.status === "drafting") return now.getTime() - row.askedAt.getTime() <= INTERVIEW_ANSWER_WINDOW_MS;
  if (row.status === "draft_sent") {
    const since = row.draftSentAt ?? row.askedAt;
    return now.getTime() - since.getTime() <= INTERVIEW_DRAFT_WINDOW_MS;
  }
  return false;
}

// ---------------------------------------------------------------------------
// O rascunho que a inteligência escreve a partir da fala
// ---------------------------------------------------------------------------

export const INTERVIEW_CAPTION_MAX_CHARS = 300;

export const INTERVIEW_DRAFT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    nota: { type: "string", description: "A nota da curadora, em primeira pessoa, com as palavras dela." },
    legenda_1: { type: "string", description: "Legenda curta de post, com a frase mais forte dela." },
    legenda_2: { type: "string", description: "Outra legenda, com outro ângulo da fala dela." },
  },
  required: ["nota", "legenda_1", "legenda_2"],
} as const;

const draftJsonSchema = z.object({
  nota: z.string(),
  legenda_1: z.string(),
  legenda_2: z.string(),
});

export type InterviewDraft = { note: string; captions: string[] };

function fitCaption(text: string): string | null {
  const clean = text.replace(/\s+/g, " ").replace(/#\S+/g, "").trim();
  if (!/[\p{L}\p{N}]/u.test(clean)) return null;
  return clean.length <= INTERVIEW_CAPTION_MAX_CHARS ? clean : `${clean.slice(0, INTERVIEW_CAPTION_MAX_CHARS - 1).trimEnd()}…`;
}

/** Resposta do modelo → rascunho limpo; lança se o formato não bate (o chamador cai no fallback). */
export function normalizeInterviewDraft(json: unknown): InterviewDraft {
  const parsed = draftJsonSchema.parse(json);
  const note = fitCuratorNote(parsed.nota).text;
  if (!note) throw new Error("nota vazia");
  const captions = [parsed.legenda_1, parsed.legenda_2].map(fitCaption).filter((caption): caption is string => caption !== null);
  return { note, captions: [...new Set(captions)] };
}

/** Sem a inteligência, a própria fala (limpa) vira a nota — nunca se perde a resposta. */
export function fallbackInterviewDraft(transcript: string): InterviewDraft | null {
  const note = fitCuratorNote(transcript).text;
  return note ? { note, captions: [] } : null;
}

export function buildInterviewDraftPrompt(input: { storeName: string; productName: string; question: string }): string {
  return [
    `Você ajuda a dona da ${input.storeName}, uma loja de moda feminina de Belém, a transformar uma resposta falada numa nota curta sobre uma peça.`,
    `A peça: ${input.productName}. A pergunta que ela respondeu: "${input.question}"`,
    "Regras:",
    "- A nota é da dona, em primeira pessoa, com as palavras e o jeito dela. Tire vícios de fala (\"né\", \"tipo\", repetições), mas NÃO invente fato, tecido, medida, preço ou promessa que ela não disse.",
    "- 1 a 3 frases, no máximo 600 caracteres.",
    "- As duas legendas são para o Instagram: 1 ou 2 frases cada, sem hashtag, no máximo um emoji, sem preço.",
    `- A loja se chama ${input.storeName}: nunca a chame de "maison".`,
    "- Se a fala não tiver nada aproveitável, devolva a fala limpa como nota e legendas vazias.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// A máquina de estados da entrevista (regra 3: nada de UPDATE status solto)
// ---------------------------------------------------------------------------

const INTERVIEW_TRANSITIONS: Record<InterviewStatus, readonly InterviewStatus[]> = {
  // pergunta feita → a resposta chegou (a inteligência escreve), ela pulou, venceu ou o envio falhou
  asked: ["drafting", "skipped", "expired", "failed"],
  // escrevendo → rascunho enviado (ou a entrevista caiu de vez)
  drafting: ["draft_sent", "failed", "expired"],
  // rascunho na mão dela → aprovou/corrigiu, pulou, venceu, ou mandou outro áudio (reescreve)
  draft_sent: ["approved", "skipped", "expired", "drafting"],
  approved: [],
  skipped: [],
  expired: [],
  failed: [],
};

export function canTransitionInterview(from: InterviewStatus, to: InterviewStatus): boolean {
  return INTERVIEW_TRANSITIONS[from].includes(to);
}

/** Os estados de onde se chega a `to` — o WHERE do UPDATE guardado no service. */
export function interviewSourcesFor(to: InterviewStatus): InterviewStatus[] {
  return INTERVIEW_STATUSES.filter((from) => INTERVIEW_TRANSITIONS[from].includes(to));
}

export function isInterviewStatus(value: string): value is InterviewStatus {
  return (INTERVIEW_STATUSES as readonly string[]).includes(value);
}

/** Como o painel mostra cada estado. */
export const INTERVIEW_STATUS_LABELS: Record<InterviewStatus, string> = {
  asked: "esperando a sua resposta",
  drafting: "escrevendo o rascunho",
  draft_sent: "rascunho esperando o seu ok",
  approved: "nota salva",
  skipped: "pulada",
  expired: "ficou sem resposta",
  failed: "não saiu",
};
