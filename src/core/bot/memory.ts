// O "caderninho" da vendedora: o que o bot sabe sobre a cliente entre um
// turno e outro, guardado em wa_conversations.bot_state (jsonb). PURO —
// quem lê e grava é src/services/wa-bot.ts.
//
// Por que existe: o histórico de mensagens é texto, e o modelo esquecia o
// SKU escolhido, o CEP e o frete assim que a janela passava. Aqui ficam só
// fatos curtos e úteis para vender de novo; nunca CPF, endereço completo
// nem dado de pagamento (esses vivem no cadastro, com as regras deles).

import { z } from "zod";

import { formatCentsBRL } from "@/lib/money";
import { spDayKey, spWeekdayName } from "@/lib/sp-day";
import { bridgeContextLine, bridgeStateSchema, isBridgeCurrent, type BridgeState } from "@/core/bot/site-bridge";

export const NOTE_MAX_CHARS = 140;
export const NOTES_MAX = 10;
export const CART_MAX_ITEMS = 12;
/** Teto por linha na sacola da conversa (a ponte do site pode trazer mais: cartAdd corta). */
export const CART_MAX_QTY = 20;

const cartItemSchema = z.object({
  sku: z.string().min(1),
  /**
   * A variante de verdade (id). O SKU é rótulo editável — quando a dona
   * renomeia a peça ou o código, é por aqui que a linha se cura. Lenient:
   * valor torto não pode derrubar o caderninho inteiro (parseBotState → {}).
   */
  variantId: z.string().optional().catch(undefined),
  quantidade: z.number().int().min(1).max(CART_MAX_QTY),
  nome: z.string().min(1),
  /** Rótulo da combinação (ex.: "Preto · M"); vazio para peça sem variação. */
  variacao: z.string().default(""),
  precoCents: z.number().int().min(0),
});

const quoteSchema = z.object({
  rateId: z.string(),
  name: z.string(),
  priceCents: z.number().int(),
  deliveryDaysMin: z.number().int(),
  deliveryDaysMax: z.number().int(),
  /** Chave da opção: rateId (Correios) ou rateId:dia:HH:MM (janela do motoboy). Ausente em estado antigo = rateId. */
  optionKey: z.string().optional(),
  kind: z.enum(["correios", "motoboy"]).optional(),
  /** Motoboy: "hoje, 19h–21h · pague até 13h". */
  label: z.string().optional(),
  window: z.object({ dayKey: z.string(), start: z.string(), end: z.string(), cutoff: z.string() }).optional(),
  /** Com data marcada: "chega sexta 16/10, 2 dias antes" / "pode chegar só…". */
  arrival: z.string().optional(),
});

export type BotQuote = z.infer<typeof quoteSchema>;

/** A chave que identifica a opção escolhida (estado antigo só tem rateId). */
export function quoteKey(quote: Pick<BotQuote, "rateId" | "optionKey">): string {
  return quote.optionKey ?? quote.rateId;
}

/** "PAC R$ 19,90 (5-8 dias úteis)" / "Motoboy hoje, 19h–21h · pague até 13h R$ 15,00". */
export function quoteSummary(quote: BotQuote): string {
  const price = formatCentsBRL(quote.priceCents);
  const when = quote.label ?? formatDays(quote.deliveryDaysMin, quote.deliveryDaysMax);
  return quote.kind === "motoboy" ? `${quote.name} ${when} ${price}` : `${quote.name} ${price} (${when})`;
}

export const botStateSchema = z
  .object({
    /** Nome do perfil do WhatsApp (vem do webhook), não o do cadastro. */
    displayName: z.string().optional(),
    /** Anotações curtas: tamanho, cores, ocasião, para quem compra. */
    notes: z.array(z.string()).optional(),
    cart: z.array(cartItemSchema).optional(),
    /** Peça que a conversa está olhando agora. */
    focus: z
      .object({
        slug: z.string(),
        nome: z.string(),
        cor: z.string().nullable().optional(),
      })
      .optional(),
    /** CEP da última cotação (cotar_frete) — o pedido só fecha com este CEP. */
    lastCep: z.string().optional(),
    /** Endereço que o CEP devolveu (sem número): a Lia pede só número e complemento. */
    lastCepAddress: z
      .object({
        street: z.string(),
        district: z.string(),
        city: z.string(),
        state: z.string(),
      })
      .optional(),
    lastQuotes: z.array(quoteSchema).optional(),
    /** Quando a cotação foi feita (ISO); cotação velha não fecha pedido. */
    lastQuotedAt: z.string().optional(),
    chosenRateId: z.string().optional(),
    /** Opção escolhida (janela do motoboy inclusa); prevalece sobre chosenRateId. */
    chosenOptionKey: z.string().optional(),
    /** Data marcada que a cliente disse ("preciso até dia 16") e a ocasião. */
    neededBy: z.string().optional(),
    occasion: z.string().optional(),
    lastOrderNumber: z.number().int().optional(),
    /**
     * Cupom que validar_cupom confirmou nesta conversa. criar_pedido aplica
     * quando o campo cupom vier ausente (o desconto é recalculado no
     * fechamento); some ao fechar o pedido.
     */
    coupon: z
      .object({
        code: z.string(),
        discountCents: z.number().int(),
        at: z.string(),
      })
      .optional(),
    /** Última transferência para a equipe: motivo e resumo para o painel. */
    handoff: z
      .object({
        motivo: z.string(),
        resumo: z.string().optional(),
        at: z.string(),
      })
      .optional(),
    /** A ponte do site: o que a cliente estava vendo quando tocou "Falar com a Lia". */
    // Ponte torta não derruba o caderninho inteiro (sacola, CEP, cupom): só ela some.
  bridge: bridgeStateSchema.optional().catch(undefined),
  })
  .loose();

export type BotState = z.infer<typeof botStateSchema>;
export type BotCartItem = z.infer<typeof cartItemSchema>;

/**
 * Linha da sacola com a quantidade FIXADA (não somada): a sacola do site é a
 * verdade do que a cliente vê — tocar duas vezes não pode dobrar a peça.
 */
export function cartSet(cart: readonly BotCartItem[] | undefined, item: BotCartItem): BotCartItem[] {
  const atual = [...(cart ?? [])];
  const indice = atual.findIndex((existente) => existente.sku.toLowerCase() === item.sku.toLowerCase());
  const linha = { ...item, quantidade: Math.min(CART_MAX_QTY, item.quantidade) };
  if (indice >= 0) {
    atual[indice] = { ...atual[indice], ...linha };
    return atual;
  }
  return [...atual, linha].slice(-CART_MAX_ITEMS);
}

/**
 * A ponte entra no caderninho: a peça vira "peça em vista"; a sacola do
 * site entra na sacola da conversa com as quantidades do site (uma conversa
 * antiga não perde o que já tinha; a mesma ponte duas vezes não dobra nada).
 * Sacola mudou → a cotação de frete anterior não vale mais (como adicionar_a_sacola).
 */
export function mergeBridgeIntoState(state: BotState, bridge: BridgeState): BotState {
  let cart = state.cart;
  if (bridge.source === "cart") {
    for (const item of bridge.items ?? []) {
      cart = cartSet(cart, {
        sku: item.sku,
        quantidade: item.quantity,
        nome: item.name,
        variacao: item.variation,
        precoCents: item.priceCents,
      });
    }
  }
  // Só o que de fato mudou invalida frete e cupom: a mesma sacola de novo
  // (toque duplo) não faz a cliente recotar nem perder o desconto validado.
  const cartChanged = JSON.stringify(cart ?? []) !== JSON.stringify(state.cart ?? []);
  return {
    ...state,
    bridge,
    ...(cart ? { cart } : {}),
    ...(cartChanged ? { lastQuotes: undefined, lastQuotedAt: undefined, chosenRateId: undefined, chosenOptionKey: undefined, coupon: undefined } : {}),
    ...(bridge.source !== "cart" && bridge.productSlug && bridge.productName
      ? { focus: { slug: bridge.productSlug, nome: bridge.productName, cor: null } }
      : {}),
  };
}

/** Tolerante: um bot_state antigo ou torto vira {} em vez de derrubar o turno. */
export function parseBotState(raw: unknown): BotState {
  const parsed = botStateSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

/** Acrescenta uma anotação curta, sem repetir e respeitando o teto. */
export function addNote(notes: readonly string[] | undefined, nota: string): string[] {
  const limpa = nota.replace(/\s+/g, " ").trim().slice(0, NOTE_MAX_CHARS);
  if (limpa === "") return [...(notes ?? [])];
  const atual = (notes ?? []).filter(
    (existente) => existente.toLowerCase() !== limpa.toLowerCase(),
  );
  return [...atual, limpa].slice(-NOTES_MAX);
}

/**
 * Coloca a peça na sacola com a quantidade como TOTAL da linha — nunca soma:
 * a Lia repete adicionar_a_sacola no turno do "SIM" e a cliente não pode
 * acabar com 2×. `quantidade` omitida garante a linha com 1 (ou mantém a
 * que já estava). Devolve também se a linha já existia, para a ferramenta
 * explicar o que (não) mudou.
 */
export function cartAdd(
  cart: readonly BotCartItem[] | undefined,
  item: Omit<BotCartItem, "quantidade"> & { quantidade?: number },
): { cart: BotCartItem[]; existed: BotCartItem | null; quantidade: number } {
  const existed = (cart ?? []).find((existente) => existente.sku.toLowerCase() === item.sku.toLowerCase()) ?? null;
  const quantidade = Math.min(CART_MAX_QTY, item.quantidade ?? existed?.quantidade ?? 1);
  return { cart: cartSet(cart, { ...item, quantidade }), existed, quantidade };
}

/** Tira UMA linha pela posição (a que findCartItem apontou) — nunca por SKU, que pode se repetir depois da cura. */
export function cartRemoveAt(cart: readonly BotCartItem[] | undefined, index: number): BotCartItem[] {
  return (cart ?? []).filter((_, i) => i !== index);
}

/** "Cropped Íris (Marrom · Tam Único)" → ["cropped", "iris", "marrom", "tam", "unico"]. */
function cartWords(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

export type CartMatch = { item: BotCartItem; index: number } | { ambiguous: BotCartItem[] } | null;

/**
 * Acha a linha que a Lia quer tirar: pelo SKU (como está na sacola), senão
 * pelo nome como a cliente fala ("o cropped marrom", "Cropped Íris Suplex") —
 * sem acento, sem maiúscula, cada palavra da consulta é prefixo de uma
 * palavra do rótulo (nome + variação). Duas linhas servindo → ambíguo.
 */
export function findCartItem(cart: readonly BotCartItem[] | undefined, query: string): CartMatch {
  const itens = cart ?? [];
  const consulta = query.trim();
  if (consulta === "") return null;
  const porSku = itens.map((item, index) => ({ item, index })).filter(({ item }) => item.sku.toLowerCase() === consulta.toLowerCase());
  if (porSku.length === 1) return porSku[0];
  if (porSku.length > 1) return { ambiguous: porSku.map(({ item }) => item) };
  const palavras = cartWords(consulta);
  if (palavras.length === 0) return null;
  const porNome = itens
    .map((item, index) => ({ item, index, rotulo: cartWords(cartItemLabel(item)) }))
    .filter(({ rotulo }) => palavras.every((palavra) => rotulo.some((word) => word.startsWith(palavra))));
  if (porNome.length === 1) return { item: porNome[0].item, index: porNome[0].index };
  if (porNome.length > 1) return { ambiguous: porNome.map(({ item }) => item) };
  return null;
}

/**
 * Depois da cura (SKU velho → atual), a linha velha e a nova da MESMA
 * variante viram uma só, com a maior quantidade. Linha sem variantId fica.
 */
export function mergeCartByVariant(cart: readonly BotCartItem[] | undefined): BotCartItem[] {
  const resultado: BotCartItem[] = [];
  for (const item of cart ?? []) {
    const indice = item.variantId ? resultado.findIndex((linha) => linha.variantId === item.variantId) : -1;
    if (indice >= 0) {
      resultado[indice] = { ...resultado[indice], quantidade: Math.max(resultado[indice].quantidade, item.quantidade) };
    } else {
      resultado.push(item);
    }
  }
  return resultado;
}

export function cartSubtotalCents(cart: readonly BotCartItem[] | undefined): number {
  return (cart ?? []).reduce(
    (soma, item) => soma + item.precoCents * item.quantidade,
    0,
  );
}

function cartItemLabel(item: BotCartItem): string {
  return item.variacao ? `${item.nome} (${item.variacao})` : item.nome;
}

/**
 * Linhas da sacola prontas para o modelo: "• 1× Vestido (Preto · M) — R$ 289,00 [sku: X]".
 * O [sku: …] é só para a ferramenta (remover, quantidade): o colchete é
 * interno (regra 23) e polishBotReply o tira se o modelo copiar.
 */
export function formatCartLines(cart: readonly BotCartItem[] | undefined): string[] {
  const itens = cart ?? [];
  if (itens.length === 0) return ["Sacola vazia."];
  return [
    ...itens.map(
      (item) =>
        `• ${item.quantidade}× ${cartItemLabel(item)} — ${formatCentsBRL(item.precoCents * item.quantidade)} [sku: ${item.sku}]`,
    ),
    `Subtotal: ${formatCentsBRL(cartSubtotalCents(itens))} (frete à parte)`,
  ];
}

export function formatCep(cep: string): string {
  const digitos = cep.replace(/\D/g, "");
  return digitos.length === 8 ? `${digitos.slice(0, 5)}-${digitos.slice(5)}` : cep;
}

function formatDays(min: number, max: number): string {
  return min === max ? `${min} dias úteis` : `${min}-${max} dias úteis`;
}

/**
 * Bloco de contexto injetado no começo de cada turno (fora do prompt de
 * sistema, para o prefixo cacheado não mudar). null quando não há nada a
 * lembrar — a primeira mensagem de uma cliente nova entra limpa.
 */
/** "sábado, 13/09/2026 (2026-09-13)" no dia de São Paulo. */
function todayLine(now: Date): string {
  const key = spDayKey(now);
  const [y, m, d] = key.split("-");
  return `${spWeekdayName(key)}, ${d}/${m}/${y} (${key})`;
}

export function renderContextNote(
  state: BotState,
  extras: { lines?: readonly string[]; now?: Date } = {},
): string | null {
  const linhas: string[] = [];

  if (state.displayName?.trim()) {
    linhas.push(`• Nome no WhatsApp: ${state.displayName.trim()}`);
  }
  // A ponte vem antes de tudo: é o motivo de a conversa existir — enquanto é
  // recente. Dias depois (ou depois do pedido, que a apaga) a conversa é outra.
  if (state.bridge && isBridgeCurrent(state.bridge, extras.now ?? new Date())) {
    linhas.push(`• ${bridgeContextLine(state.bridge, extras.now ?? new Date())}`);
  }
  if (state.notes && state.notes.length > 0) {
    linhas.push(`• Anotações: ${state.notes.join("; ")}`);
  }
  if (state.cart && state.cart.length > 0) {
    linhas.push(
      `• Sacola agora: ${state.cart
        .map((item) => `${item.quantidade}× ${cartItemLabel(item)} [sku: ${item.sku}]`)
        .join(", ")} — subtotal ${formatCentsBRL(cartSubtotalCents(state.cart))}`,
    );
  }
  if (state.focus) {
    linhas.push(
      `• Peça em vista: ${state.focus.nome}${state.focus.cor ? ` (cor ${state.focus.cor})` : ""}`,
    );
  }
  if (state.neededBy) {
    const [y, m, d] = state.neededBy.split("-");
    linhas.push(`• Data marcada: precisa até ${d}/${m}/${y} (entregar_ate: ${state.neededBy})${state.occasion ? ` — ${state.occasion}` : ""} — repita entregar_ate em cotar_frete e criar_pedido`);
  }
  if (state.lastCep) {
    const cotacoes = (state.lastQuotes ?? [])
      .map((quote) => `${quoteSummary(quote)}${quote.arrival ? ` · ${quote.arrival}` : ""}`)
      .join(", ");
    const chosenKey = state.chosenOptionKey ?? state.chosenRateId;
    const escolhido = state.lastQuotes?.find((quote) => quoteKey(quote) === chosenKey);
    // Sacola mudou depois da cotação (adicionar/remover zeram lastQuotes):
    // o CEP fica como pista, mas o frete tem de ser cotado de novo.
    // Cotação feita e vazia (lista [], não ausente): fora da área do motoboy.
    const foraDaArea = Array.isArray(state.lastQuotes) && state.lastQuotes.length === 0 && Boolean(state.lastQuotedAt);
    linhas.push(
      cotacoes
        ? `• CEP informado: ${formatCep(state.lastCep)} · frete cotado: ${cotacoes}${escolhido ? ` · escolhido: ${escolhido.label ? `${escolhido.name} ${escolhido.label}` : escolhido.name}` : ""}`
        : foraDaArea
          ? `• CEP informado: ${formatCep(state.lastCep)} · FORA DA ÁREA DO MOTOBOY: entrega pelos Correios com o frete calculado pela equipe — com a sacola pronta, confirme o endereço completo e chame transferir_para_atendente com o resumo; NÃO chame criar_pedido`
          : `• CEP informado: ${formatCep(state.lastCep)} · frete ainda NÃO cotado para a sacola atual — chame cotar_frete antes do resumo`,
    );
    if (state.lastCepAddress) {
      const endereco = state.lastCepAddress;
      const local = [endereco.street, endereco.district].filter((parte) => parte.trim() !== "").join(", ");
      linhas.push(
        `• Endereço do CEP: ${local ? `${local} — ` : ""}${endereco.city}/${endereco.state} (peça só número e complemento)`,
      );
    }
  }
  if (state.coupon) {
    linhas.push(
      `• Cupom validado nesta conversa: ${state.coupon.code} (desconto de ${formatCentsBRL(state.coupon.discountCents)} nesta sacola) — criar_pedido aplica sozinho e recalcula no fechamento; para NÃO usar, passe cupom vazio ""`,
    );
  }
  if (state.lastOrderNumber !== undefined) {
    linhas.push(`• Último pedido nesta conversa: #${state.lastOrderNumber}`);
  }
  // Linhas vindas de outras fontes de verdade (reserva ativa, avisos pedidos,
  // cartela) — o caderninho não duplica o que já mora em tabela própria.
  for (const line of extras.lines ?? []) {
    if (line.trim() !== "") linhas.push(`• ${line.trim()}`);
  }

  if (linhas.length === 0) return null;
  // O modelo não sabe que dia é hoje (o prefixo cacheado não tem data): a
  // nota do turno diz, para "até dia 16" virar AAAA-MM-DD certo. Só entra
  // quando há caderninho (sem nada a lembrar, o turno segue sem nota; o
  // executor de agendar_retorno diz a data quando o plano não fecha).
  linhas.push(`• Hoje: ${todayLine(extras.now ?? new Date())}`);
  return [
    "CADERNINHO (memória interna da vendedora sobre esta cliente — contexto, NÃO é fala dela; use sem repetir literalmente):",
    ...linhas,
  ].join("\n");
}
