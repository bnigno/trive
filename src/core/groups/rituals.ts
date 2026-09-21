// Os textos dos rituais do Provador, renderizados de dados — nunca escritos
// à mão na hora de enviar. A voz é a da TRIVÉ: curta, concreta, "a gente";
// estoque de verdade (do ledger), nunca "últimas unidades!"; o grupo nunca
// vende — todo post termina com um toque para a Lia. Puro.
import { formatCentsBRL } from "@/lib/money";

export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 12;
export const POLL_OPTION_MAX_CHARS = 100;
export const POLL_QUESTION_MAX_CHARS = 255;
/** O WhatsApp aceita mais, mas um post do Provador que passe disso vira muro de texto. */
export const GROUP_POST_MAX_CHARS = 1_500;
/** Quantas peças cabem num "Passou pelo Provador" sem virar catálogo. */
export const CHEGADAS_MAX_ITEMS = 3;
/** A partir de quantas unidades por tamanho o número deixa de importar ("tem P, M e G"). */
const PLENTY_PER_SIZE = 4;

export interface StockBySize {
  size: string;
  quantity: number;
}

export interface ChegadasItem {
  name: string;
  priceCents: number;
  /** Só tamanhos com estoque > 0 entram no texto; ordem = ordem do catálogo. */
  stockBySize: readonly StockBySize[];
}

export interface ChegadasPostInput {
  items: readonly ChegadasItem[];
  /** Link da Lia rastreável (campaign link do post). */
  liaLink: string;
  /** "amanhã às 9h" — quando vai para a vitrine; vazio = já está na vitrine. */
  vitrineWhen?: string;
  /** Dias da proteção de preço; null/0 = a promessa não entra no texto. */
  priceProtectionDays?: number | null;
  /** Horas da reserva gentil (padrão 24). */
  holdHours?: number;
}

/** "R$ 289" quando é redondo, "R$ 189,90" quando não é. */
export function formatPriceShort(cents: number): string {
  const full = formatCentsBRL(cents);
  return full.endsWith(",00") ? full.slice(0, -3) : full;
}

function joinPt(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} e ${parts[parts.length - 1]}`;
}

/**
 * "tem 2 P, 3 M, 1 G" · "tem P, M e G" (todos ≥ 4) · "só 2 M" (um tamanho,
 * até 3) · "esgotou" (nada). Os números são os do ledger — honestidade é a
 * regra; quando sobra bastante, o número só faria barulho.
 */
export function formatStockLine(stockBySize: readonly StockBySize[]): string {
  const available = stockBySize.filter((entry) => entry.quantity > 0);
  if (available.length === 0) return "esgotou";
  if (available.length === 1) {
    const only = available[0] as StockBySize;
    if (only.quantity < PLENTY_PER_SIZE) return `só ${only.quantity} ${only.size}`;
    return `tem ${only.size}`;
  }
  if (available.every((entry) => entry.quantity >= PLENTY_PER_SIZE)) {
    return `tem ${joinPt(available.map((entry) => entry.size))}`;
  }
  return `tem ${available.map((entry) => `${entry.quantity} ${entry.size}`).join(", ")}`;
}

export function renderChegadasPost(input: ChegadasPostInput): string {
  const items = input.items.slice(0, CHEGADAS_MAX_ITEMS);
  if (items.length === 0) throw new RangeError("Passou pelo Provador precisa de pelo menos uma peça.");
  const holdHours = input.holdHours ?? 24;
  const lines = items.map(
    (item, index) => `${index + 1}. ${item.name} — ${formatPriceShort(item.priceCents)} · ${formatStockLine(item.stockBySize)}`,
  );
  const plural = items.length > 1;
  const vitrine = input.vitrineWhen?.trim()
    ? `${plural ? "Vão" : "Vai"} para a vitrine ${input.vitrineWhen.trim()}. Quem quiser antes: ${input.liaLink} — eu seguro por ${holdHours} h no seu tamanho.`
    : `Quer ${plural ? "alguma delas" : "ela"}? ${input.liaLink} — eu seguro por ${holdHours} h no seu tamanho.`;
  const parts = [
    `Passou pelo Provador hoje:`,
    lines.join("\n"),
    input.priceProtectionDays
      ? `${vitrine}\nPreço protegido: se baixar em ${input.priceProtectionDays} dias, a diferença volta em cupom.`
      : vitrine,
  ];
  return parts.join("\n\n");
}

export interface PollInput {
  question: string;
  options: readonly string[];
  /** "chega em 15 dias" — o que acontece com a vencedora; vazio = sem promessa. */
  outcome?: string;
  /** Horas da reserva gentil de quem votou na vencedora; 0/undefined = sem recompensa. */
  voterHoldHours?: number;
}

export interface RenderedPoll {
  /** O texto que vai no campo `message` da enquete. */
  message: string;
  options: string[];
}

export type PollProblem = "poucas_opcoes" | "muitas_opcoes" | "opcao_repetida" | "opcao_longa" | "opcao_vazia" | "pergunta_vazia" | "pergunta_longa";

export const POLL_PROBLEM_MESSAGES: Record<PollProblem, string> = {
  poucas_opcoes: `Uma enquete precisa de pelo menos ${POLL_MIN_OPTIONS} opções.`,
  muitas_opcoes: `O WhatsApp aceita no máximo ${POLL_MAX_OPTIONS} opções.`,
  opcao_repetida: "Duas opções iguais confundem a votação.",
  opcao_longa: `Cada opção cabe em ${POLL_OPTION_MAX_CHARS} caracteres.`,
  opcao_vazia: "Tem uma opção em branco.",
  pergunta_vazia: "A enquete precisa de uma pergunta.",
  pergunta_longa: `A pergunta cabe em ${POLL_QUESTION_MAX_CHARS} caracteres.`,
};

/** null quando a enquete está boa; senão o primeiro problema, na ordem em que a dona corrige. */
export function pollProblem(input: PollInput): PollProblem | null {
  const question = input.question.trim();
  if (question === "") return "pergunta_vazia";
  if (question.length > POLL_QUESTION_MAX_CHARS) return "pergunta_longa";
  const options = input.options.map((option) => option.trim());
  if (options.length < POLL_MIN_OPTIONS) return "poucas_opcoes";
  if (options.length > POLL_MAX_OPTIONS) return "muitas_opcoes";
  if (options.some((option) => option === "")) return "opcao_vazia";
  if (options.some((option) => option.length > POLL_OPTION_MAX_CHARS)) return "opcao_longa";
  const folded = options.map((option) => option.toLowerCase());
  if (new Set(folded).size !== folded.length) return "opcao_repetida";
  return null;
}

export function renderPoll(input: PollInput): RenderedPoll {
  const problem = pollProblem(input);
  if (problem) throw new RangeError(POLL_PROBLEM_MESSAGES[problem]);
  const lines = [`Vocês decidem. ${input.question.trim()}`];
  const tail: string[] = [];
  if (input.outcome?.trim()) tail.push(`A que ganhar ${input.outcome.trim()}.`);
  if (input.voterHoldHours && input.voterHoldHours > 0) {
    tail.push(`Quem votou nela tem ${input.voterHoldHours} h de reserva antes de todo mundo.`);
  }
  if (tail.length > 0) lines.push(tail.join(" "));
  return { message: lines.join("\n"), options: input.options.map((option) => option.trim()) };
}

export interface PollTally {
  option: string;
  votes: number;
}

/**
 * Apura os votos: cada voto é a lista de opções que a pessoa marcou (a última
 * escolha dela). Devolve a contagem na ordem das opções e a vencedora — em
 * empate, a primeira da lista (a ordem da enquete é a ordem da dona).
 */
export function tallyPoll(options: readonly string[], votes: readonly (readonly string[])[]): { tally: PollTally[]; winner: string | null; voters: number } {
  const counts = new Map<string, number>(options.map((option) => [option, 0]));
  let voters = 0;
  for (const chosen of votes) {
    const distinct = new Set(chosen.filter((option) => counts.has(option)));
    if (distinct.size === 0) continue;
    voters += 1;
    for (const option of distinct) counts.set(option, (counts.get(option) ?? 0) + 1);
  }
  const tally = options.map((option) => ({ option, votes: counts.get(option) ?? 0 }));
  let winner: PollTally | null = null;
  for (const entry of tally) {
    if (entry.votes > 0 && (winner === null || entry.votes > winner.votes)) winner = entry;
  }
  return { tally, winner: winner?.option ?? null, voters };
}

export function renderPollResultPost(input: {
  winner: string;
  winnerVotes: number;
  voters: number;
  /** "chega em 15 dias"; vazio = sem promessa. */
  outcome?: string;
  voterHoldHours?: number;
}): string {
  const lines = [`Deu ${input.winner}: ${input.winnerVotes} de ${input.voters} ${input.voters === 1 ? "voto" : "votos"}.`];
  const tail: string[] = [];
  if (input.outcome?.trim()) tail.push(`Ela ${input.outcome.trim()}.`);
  if (input.voterHoldHours && input.voterHoldHours > 0) {
    tail.push(`Quem votou nela recebe ${input.voterHoldHours} h de reserva no privado quando chegar.`);
  }
  if (tail.length > 0) lines.push(tail.join(" "));
  return lines.join("\n");
}

export interface QuemVestiuLook {
  /** Primeiro nome, como ela autorizou aparecer. */
  firstName: string;
  productName: string;
  size?: string | null;
  /** "no casamento da irmã" — a ocasião nas palavras dela; vazio = sem. */
  occasion?: string | null;
}

export function renderQuemVestiuPost(input: {
  looks: readonly QuemVestiuLook[];
  liaLink: string;
  /** "21h" — até que hora a Lia fica no privado hoje. */
  until: string;
  /** A foto vira cupom? (look_photo da Onda 6) */
  photoCoupon?: boolean;
}): string {
  const looks = input.looks.slice(0, 2);
  if (looks.length === 0) throw new RangeError("Quem vestiu precisa de pelo menos um look.");
  const openings = looks.map((look) => {
    const where = look.occasion?.trim() ? ` ${look.occasion.trim()}` : "";
    const size = look.size?.trim() ? ` em ${look.size.trim()}` : "";
    return `${look.firstName.trim()}${where}, com ${look.productName.trim()}${size}.`;
  });
  const consent = looks.length === 1 ? "Ela mandou a foto e deixou a gente mostrar." : "Elas mandaram as fotos e deixaram a gente mostrar.";
  const parts = [
    `${openings.join(" ")} ${consent}`,
    `Tem ocasião chegando? Estou no privado até as ${input.until} montando look com data marcada — me diz o dia e eu cuido do resto: ${input.liaLink}`,
  ];
  if (input.photoCoupon) parts.push("Mandou foto vestindo a peça? Vira cupom na próxima compra.");
  return parts.join("\n\n");
}

export function renderWelcomeCard(input: {
  storeName: string;
  sellerName: string;
  firstName?: string | null;
  /** Horas da janela (padrão 9–21). */
  windowStartHour?: number;
  windowEndHour?: number;
  postsPerWeek?: number;
}): string {
  const name = input.firstName?.trim() ? `, ${input.firstName.trim()}` : "";
  const start = input.windowStartHour ?? 9;
  const end = input.windowEndHour ?? 21;
  const posts = input.postsPerWeek ?? 3;
  const postsWord = posts === 1 ? "uma mensagem" : `${["", "uma", "duas", "três", "quatro", "cinco", "seis", "sete"][posts] ?? posts} mensagens`;
  return [
    `Bem-vinda ao Provador ${input.storeName}${name}. Aqui as peças passam antes de ir para a vitrine.`,
    `Como funciona:\n• Terça — o que chegou, com o estoque de verdade por tamanho.\n• Quinta — vocês decidem: uma enquete escolhe cor, reposição ou a próxima peça.\n• Sábado — quem vestiu, com foto de cliente de verdade.`,
    `Só isso: ${postsWord} por semana, entre ${start}h e ${end}h. Nada de bom dia, nada de corrente.`,
    `Curtiu uma peça? Reage ❤️ que eu anoto no seu caderninho e te aviso se ficar a última no seu tamanho.\nQuer perguntar? Me chama aqui (@${input.sellerName}) ou no privado — eu lembro do seu tamanho e das suas cores.`,
    `Seu número fica visível para as outras do grupo. Se preferir, manda "só privado" que eu te tiro do grupo e continuo te avisando só do que serve. "SAIR" desliga tudo.`,
  ].join("\n\n");
}

/** Post longo demais vira muro de texto no celular: o painel recusa antes de agendar. */
export function groupPostProblem(body: string): string | null {
  const text = body.trim();
  if (text === "") return "O post está vazio.";
  if (text.length > GROUP_POST_MAX_CHARS) return `O post passa de ${GROUP_POST_MAX_CHARS} caracteres — no celular vira muro de texto.`;
  return null;
}
