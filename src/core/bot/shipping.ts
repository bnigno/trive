// A guarda do frete no fechamento pela vendedora — PURO.
//
// Incidente de 2026-09-11 (pedido #1012): a cliente aprovou "Benevides,
// R$ 8,00" e o pedido nasceu com "Belém, R$ 10,00", porque o executor
// recotava com o CEP do endereço salvo e aceitava a única opção que voltou.
// Regra desta unidade: o pedido só fecha com uma cotação feita NESTA
// conversa, para o MESMO CEP do endereço de entrega, ainda válida e igual à
// tarifa de agora. Qualquer divergência vira recusa com instrução — nunca
// uma troca silenciosa de endereço ou valor.

import { formatCentsBRL } from "@/lib/money";

import { formatCep, quoteKey, type BotQuote } from "./memory";

/** Depois disso a cotação é velha demais para fechar: cote de novo. */
export const QUOTE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type PickedQuote =
  | { kind: "picked"; quote: BotQuote }
  | { kind: "unrecognized"; term: string }
  | { kind: "missing" };

export type QuoteResolution = { ok: true; quote: BotQuote } | { ok: false; text: string };

function formatDays(min: number, max: number): string {
  return min === max ? `${min} dias úteis` : `${min}-${max} dias úteis`;
}

/**
 * "1. PAC — R$ 19,90 (5-8 dias úteis)" e, para o motoboy, "2. Motoboy —
 * hoje, 19h–21h — R$ 15,00 (pague até 13h)". Com data marcada, cada linha
 * ganha " · chega sexta 16/10, 2 dias antes".
 */
export function formatQuoteLines(quotes: readonly BotQuote[]): string[] {
  return quotes.map((quote, index) => {
    const price = formatCentsBRL(quote.priceCents);
    const arrival = quote.arrival ? ` · ${quote.arrival}` : "";
    if (quote.kind === "motoboy" && quote.label) {
      const [range, cutoff] = quote.label.split(" · ");
      return `${index + 1}. ${quote.name} — ${range} — ${price}${cutoff ? ` (${cutoff})` : ""}${arrival}`;
    }
    return `${index + 1}. ${quote.name} — ${price} (${formatDays(quote.deliveryDaysMin, quote.deliveryDaysMax)})${arrival}`;
  });
}

function normalizeTerm(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

const FILLER = new Set(["o", "a", "os", "as", "de", "do", "da", "dos", "das", "na", "no", "pra", "para", "pelo", "pela", "com", "quero", "mesmo", "opcao", "janela", "hora", "horario"]);

/** O texto pelo qual a cliente reconhece a opção: nome + janela ("motoboy hoje, 19h–21h · pague até 13h"). */
function quoteText(quote: BotQuote): string {
  return normalizeTerm(quote.label ? `${quote.name} ${quote.label}` : quote.name);
}

/**
 * A opção que a cliente escolheu, entre as cotações desta conversa: pelo
 * número da lista ("2"), pelo nome ("SEDEX", sem caixa) ou por parte dele.
 * Termo que não bate com nada é `unrecognized` MESMO com uma opção só — o
 * modelo escreveu um frete que a cliente não viu. Sem termo: uma opção (ou
 * várias com o mesmo nome) é a escolha; senão vale o id já escolhido; senão
 * `missing`.
 */
export function pickChosenQuote(
  quotes: readonly BotQuote[],
  input: string | undefined,
  chosenKey: string | undefined,
): PickedQuote {
  const term = normalizeTerm(input ?? "");
  if (term !== "") {
    const byIndex = /^\d+$/.test(term) ? quotes[Number(term) - 1] : undefined;
    if (byIndex) return { kind: "picked", quote: byIndex };
    // Texto exato da opção, depois "motoboy 19h" (todas as palavras do termo
    // aparecem na opção) — só quando isso aponta UMA opção; por fim o nome
    // solto, que só serve quando não há janelas homônimas.
    const exact = quotes.find((quote) => quoteText(quote) === term);
    if (exact) return { kind: "picked", quote: exact };
    // Palavras que dizem algo ("motoboy", "amanha", "hoje"); números soltos e
    // "19h" ficam para a regra da hora; artigos e preposições não contam.
    const words = term.split(" ").filter((word) => word.length > 1 && !/^\d+(?:h(?:\d{2})?)?$/.test(word) && !FILLER.has(word));
    // "motoboy 19h" / "a das 16h": a hora é o começo da janela — mas o resto
    // do termo tem de bater ("motoboy amanhã 19h" NÃO é a janela de hoje).
    const hour = /(?:^|\D)(\d{1,2})h(?:\d{2})?(?:\D|$)/.exec(term);
    if (hour) {
      const byStart = quotes.filter((quote) => quote.window && Number(quote.window.start.split(":")[0]) === Number(hour[1]));
      const narrowed = words.length > 0 ? byStart.filter((quote) => words.every((word) => quoteText(quote).includes(word))) : byStart;
      if (narrowed.length === 1) return { kind: "picked", quote: narrowed[0] };
      if (byStart.length > 0) return { kind: "unrecognized", term: input!.trim() };
    }
    const byWords = words.length > 0 ? quotes.filter((quote) => words.every((word) => quoteText(quote).includes(word))) : [];
    if (byWords.length === 1) return { kind: "picked", quote: byWords[0] };
    const byName = quotes.filter((quote) => normalizeTerm(quote.name).includes(term) || term.includes(normalizeTerm(quote.name)));
    if (byName.length === 1) return { kind: "picked", quote: byName[0] };
    if (byName.length > 1 && new Set(byName.map(quoteText)).size === 1) return { kind: "picked", quote: byName[0] };
    return { kind: "unrecognized", term: input!.trim() };
  }
  if (quotes.length === 1) return { kind: "picked", quote: quotes[0] };
  // Opções com o mesmo nome (duas faixas "PAC") não são uma escolha real:
  // vale a mais barata (cotar_frete ordena por preço).
  if (quotes.length > 1 && new Set(quotes.map(quoteText)).size === 1) {
    return { kind: "picked", quote: quotes[0] };
  }
  if (chosenKey) {
    const byKey = quotes.find((quote) => quoteKey(quote) === chosenKey);
    if (byKey) return { kind: "picked", quote: byKey };
  }
  return { kind: "missing" };
}

export type ResolveApprovedQuoteInput = {
  /** CEP da última cotar_frete desta conversa (caderninho). */
  quotedCep: string | undefined;
  quotes: readonly BotQuote[] | undefined;
  /** Chave da opção já escolhida (chosenOptionKey, ou o chosenRateId do estado antigo). */
  chosenRateId: string | undefined;
  /** Quando a cotação foi feita (ISO); ausente em estado antigo = aceita. */
  quotedAt?: string | undefined;
  /** CEP do endereço que VAI no pedido. */
  orderCep: string;
  /** Campo `frete` de criar_pedido. */
  freteInput: string | undefined;
  now?: Date;
};

/**
 * A cotação que a cliente aprovou, ou a recusa com a instrução para o
 * modelo. Ordem: existe cotação → é recente → é do CEP do endereço → a
 * escolha é reconhecível.
 */
export function resolveApprovedQuote(input: ResolveApprovedQuoteInput): QuoteResolution {
  const orderCep = input.orderCep.replace(/\D/g, "");
  const quotes = input.quotes ?? [];

  if (quotes.length === 0 || !input.quotedCep) {
    return {
      ok: false,
      text: `Ainda não há cotação de frete para esta sacola. Chame cotar_frete com o CEP ${formatCep(orderCep)} (o do endereço de entrega), apresente o resumo com o frete cotado e, com o SIM da cliente, chame criar_pedido de novo.`,
    };
  }

  if (input.quotedAt) {
    const quotedAtMs = Date.parse(input.quotedAt);
    const nowMs = (input.now ?? new Date()).getTime();
    if (Number.isNaN(quotedAtMs) || nowMs - quotedAtMs > QUOTE_MAX_AGE_MS) {
      return {
        ok: false,
        text: `A cotação de frete desta conversa é antiga. Chame cotar_frete de novo com o CEP ${formatCep(orderCep)}, apresente o resumo atualizado e, com o SIM da cliente, chame criar_pedido de novo.`,
      };
    }
  }

  const quotedCep = input.quotedCep.replace(/\D/g, "");
  if (quotedCep !== orderCep) {
    return {
      ok: false,
      text: `O frete foi cotado para o CEP ${formatCep(quotedCep)}, mas o endereço de entrega deste pedido tem CEP ${formatCep(orderCep)} — o valor que a cliente viu não vale para ele. Chame cotar_frete com o CEP ${formatCep(orderCep)}, apresente o novo resumo e, com o SIM dela, chame criar_pedido de novo. Se a entrega é no endereço do CEP ${formatCep(quotedCep)}, passe esse endereço completo nos campos de criar_pedido.`,
    };
  }

  const picked = pickChosenQuote(quotes, input.freteInput, input.chosenRateId);
  if (picked.kind === "picked") return { ok: true, quote: picked.quote };
  if (picked.kind === "unrecognized") {
    return {
      ok: false,
      text: [
        `A opção de frete "${picked.term}" não é nenhuma das cotadas nesta conversa. Passe em frete o nome ou o número EXATAMENTE como cotar_frete devolveu:`,
        ...formatQuoteLines(quotes),
      ].join("\n"),
    };
  }
  return {
    ok: false,
    text: [
      "Há mais de uma opção de entrega e a escolha da cliente não veio (campo frete). Pergunte qual ela prefere e chame de novo:",
      ...formatQuoteLines(quotes),
    ].join("\n"),
  };
}

/**
 * Segunda rede, na hora do fechamento: a tarifa aprovada ainda existe para
 * este CEP e custa o mesmo? Devolve a cotação FRESCA (mesmo id, mesmo
 * preço) — é ela que vai para o pedido.
 */
export function confirmQuoteUnchanged(
  approved: BotQuote,
  fresh: readonly BotQuote[],
  orderCep: string,
): QuoteResolution {
  const cep = formatCep(orderCep.replace(/\D/g, ""));
  if (fresh.length === 0) {
    return {
      ok: false,
      text: "Não entregamos para este CEP no momento. Confira se o CEP está correto, por favor.",
    };
  }
  const current = fresh.find((quote) => quoteKey(quote) === quoteKey(approved));
  if (!current) {
    // Só é "passou da hora-limite" quando a faixa ainda existe com outra janela; senão a faixa sumiu mesmo.
    const sameRateOtherWindow = approved.kind === "motoboy" && fresh.some((quote) => quote.rateId === approved.rateId);
    const what = sameRateOtherWindow && approved.label ? `A janela do motoboy (${approved.label}) já passou da hora-limite` : `A opção ${approved.label ? `${approved.name} ${approved.label}` : approved.name} não está mais disponível para o CEP ${cep}`;
    return {
      ok: false,
      text: `${what}. Chame cotar_frete de novo, apresente as opções atuais e, com o SIM da cliente, chame criar_pedido de novo.`,
    };
  }
  if (current.priceCents !== approved.priceCents) {
    return {
      ok: false,
      text: `O frete ${approved.name} mudou de ${formatCentsBRL(approved.priceCents)} para ${formatCentsBRL(current.priceCents)} desde a cotação. Chame cotar_frete de novo, apresente o resumo atualizado e, com o SIM da cliente, chame criar_pedido de novo.`,
    };
  }
  return { ok: true, quote: current };
}
