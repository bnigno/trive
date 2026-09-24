// "Me ajuda a escolher?": a cliente em dúvida entre 2 ou 3 peças manda um
// link para as amigas; cada uma vota com um toque (sem cadastro) e pode
// deixar um recado. O placar volta para a cliente pela Lia em dois momentos
// — um resumo pouco depois do primeiro voto e o fechamento. PURO: prazos,
// limpeza do que a amiga escreve, contagem e os textos do placar.

import { spDayKey, spNextDayKey, spTimeLabel } from "@/lib/sp-day";

export const DECISION_MIN_OPTIONS = 2;
export const DECISION_MAX_OPTIONS = 3;
export const DECISION_LETTERS = ["A", "B", "C"] as const;
/** A rodada fica aberta por um dia: dúvida de roupa não espera uma semana. */
export const ROUND_OPEN_MS = 24 * 60 * 60 * 1000;
/** O resumo sai 10 min depois do PRIMEIRO voto: dá tempo de as outras amigas votarem junto. */
export const SUMMARY_DELAY_MS = 10 * 60 * 1000;
/** Votos e recados somem 30 dias depois do fim (o hash do aparelho é dado pseudônimo). */
export const ANSWER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const DISPLAY_NAME_MAX = 30;
/** Teto de votos por rodada: dúvida de roupa é entre amigas, não enquete aberta. */
export const ROUND_MAX_VOTES = 60;
export const NOTE_MAX = 140;
export const NICKNAME_MAX = 30;
/** Recados que entram numa mensagem para a cliente. */
export const NOTES_PER_MESSAGE = 3;

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function hasLetters(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/**
 * O nome que aparece para as amigas ("Qual fica melhor na Ana?"): só o
 * primeiro nome — o link circula em grupos, e o nome do WhatsApp dela
 * ("Ana Paula Ferreira", "Ana 🌸 Moda Fit") não precisa ir junto.
 */
export function normalizeDisplayName(raw: string): string | null {
  const first = squash(raw.replace(/https?:\/\/\S+/gi, ""))
    .split(" ")
    .find((word) => /\p{L}/u.test(word));
  if (!first) return null;
  const name = first.replace(/[^\p{L}'-]/gu, "").slice(0, DISPLAY_NAME_MAX);
  return hasLetters(name) ? name : null;
}

/**
 * O recado da amiga vai para a cliente pelo WhatsApp da loja: sem link (a
 * loja não repassa link de terceiro), sem quebra de linha, no máximo 140.
 */
export function normalizeNote(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const note = squash(
    raw
      .replace(/https?:\/\/\S+/gi, "")
      // Domínio sem "http" (bit.ly/x, site.com.br) o WhatsApp também transforma em link.
      .replace(/\b[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}(?:\/\S*)?/gi, "")
      // Telefone, Pix e @perfil não passam pelo número da loja.
      .replace(/\(?\+?\d[\d\s().-]{6,}\d/g, "")
      .replace(/@\w+/g, ""),
  )
    .slice(0, NOTE_MAX)
    .trim();
  return hasLetters(note) ? note : null;
}

/** Palavras que fariam o recado parecer da própria loja. */
const RESERVED_NICKNAME = /\b(trive|triv[eéë]|loja|equipe|atendimento|oficial|lia|vendedora|suporte)\b/iu;

/** O nome de quem deixou o recado: só letras, e nunca se passando pela loja. */
export function normalizeNickname(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const nickname = squash(raw.replace(/[^\p{L}\s'-]/gu, " ")).slice(0, NICKNAME_MAX).trim();
  if (!hasLetters(nickname) || RESERVED_NICKNAME.test(nickname.normalize("NFD").replace(/\p{Diacritic}/gu, ""))) return null;
  return nickname;
}

export function roundClosesAt(now: Date): Date {
  return new Date(now.getTime() + ROUND_OPEN_MS);
}

export function isRoundOpen(round: { closesAt: Date; closedAt: Date | null }, now: Date): boolean {
  return round.closedAt === null && now.getTime() < round.closesAt.getTime();
}

export type RoundTally = {
  counts: number[];
  total: number;
  /** Índice da opção na frente; null sem votos ou com empate no topo. */
  leader: number | null;
};

export function tallyRound(optionCount: number, answers: readonly { choice: number }[]): RoundTally {
  const counts = Array.from({ length: optionCount }, () => 0);
  for (const answer of answers) {
    if (Number.isInteger(answer.choice) && answer.choice >= 0 && answer.choice < optionCount) counts[answer.choice] += 1;
  }
  const total = counts.reduce((sum, count) => sum + count, 0);
  const top = Math.max(0, ...counts);
  const leaders = counts.flatMap((count, index) => (count === top && top > 0 ? [index] : []));
  return { counts, total, leader: leaders.length === 1 ? leaders[0] : null };
}

export type RoundOptionLabel = { letter: string; name: string };

/** "B · Longo Dunas (areia)" — a opção como a cliente escolheu. */
export function optionLabel(index: number, name: string, detail: string | null): RoundOptionLabel {
  const letter = DECISION_LETTERS[index] ?? String(index + 1);
  const text = detail ? `${name} (${detail})` : name;
  return { letter, name: text };
}

function votesWord(count: number): string {
  return count === 1 ? "1 voto" : `${count} votos`;
}

/** "B, Longo Dunas: 2 votos · A, Kimono Maré: 1 voto" — da mais votada para a menos. */
export function scoreboardLine(options: readonly RoundOptionLabel[], tally: RoundTally): string {
  return options
    .map((option, index) => ({ option, count: tally.counts[index] ?? 0, index }))
    .sort((a, b) => b.count - a.count || a.index - b.index)
    .map(({ option, count }) => `${option.letter}, ${option.name}: ${votesWord(count)}`)
    .join(" · ");
}

/** Recados (os mais recentes primeiro): "💬 Carla (B): combina com teu cabelo". São de quem votou, não da loja. */
export function notesBlock(options: readonly RoundOptionLabel[], notes: readonly { nickname: string | null; note: string; choice: number }[]): string {
  const lines = notes
    .slice(0, NOTES_PER_MESSAGE)
    .map((entry) => `💬 ${entry.nickname ?? "Alguém"} (${options[entry.choice]?.letter ?? "?"}): ${entry.note}`);
  return lines.length > 0 ? `\n\nRecados de quem votou:\n${lines.join("\n")}` : "";
}

/** "hoje às 20h", "amanhã às 9h30", "12/10 às 10h" — no relógio de São Paulo. */
export function closesLabel(closesAt: Date, now: Date): string {
  const day = spDayKey(closesAt);
  const time = spTimeLabel(closesAt).replace(/^0/, "").replace(/:00$/, "h").replace(":", "h");
  if (day === spDayKey(now)) return `hoje às ${time}`;
  if (day === spNextDayKey(spDayKey(now))) return `amanhã às ${time}`;
  const [, month, date] = day.split("-");
  return `${date}/${month} às ${time}`;
}

/** O fecho: quem ganhou, ou o empate honesto — e a pergunta de separar a peça. */
function listLetters(letters: readonly string[]): string {
  return letters.length <= 1 ? (letters[0] ?? "") : `${letters.slice(0, -1).join(", ")} e ${letters[letters.length - 1]}`;
}

export function closingLine(options: readonly RoundOptionLabel[], tally: RoundTally): string {
  if (tally.total === 0) return "Ninguém votou a tempo. Se quiser, eu te ajudo a escolher por aqui.";
  if (tally.leader === null) {
    const tied = options.filter((_, index) => (tally.counts[index] ?? 0) === Math.max(...tally.counts)).map((option) => option.letter);
    return `Deu empate entre ${listLetters(tied)} — vai ter que ser o seu coração 😄 Quer que eu separe uma delas pra você?`;
  }
  const winner = options[tally.leader];
  return `A mais votada foi a ${winner.letter}: ${winner.name}. Quer que eu separe pra você? É só responder *sim* (e o tamanho, se ainda não me disse).`;
}
