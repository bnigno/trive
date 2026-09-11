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

export const NOTE_MAX_CHARS = 140;
export const NOTES_MAX = 10;
export const CART_MAX_ITEMS = 12;

const cartItemSchema = z.object({
  sku: z.string().min(1),
  quantidade: z.number().int().min(1).max(20),
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
});

export type BotQuote = z.infer<typeof quoteSchema>;

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
  })
  .loose();

export type BotState = z.infer<typeof botStateSchema>;
export type BotCartItem = z.infer<typeof cartItemSchema>;

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

export function cartAdd(
  cart: readonly BotCartItem[] | undefined,
  item: BotCartItem,
): BotCartItem[] {
  const atual = [...(cart ?? [])];
  const indice = atual.findIndex(
    (existente) => existente.sku.toLowerCase() === item.sku.toLowerCase(),
  );
  if (indice >= 0) {
    const existente = atual[indice];
    atual[indice] = {
      ...existente,
      ...item,
      quantidade: Math.min(20, existente.quantidade + item.quantidade),
    };
    return atual;
  }
  return [...atual, item].slice(-CART_MAX_ITEMS);
}

export function cartRemove(
  cart: readonly BotCartItem[] | undefined,
  sku: string,
): BotCartItem[] {
  return (cart ?? []).filter(
    (item) => item.sku.toLowerCase() !== sku.trim().toLowerCase(),
  );
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

/** Linhas da sacola prontas para o modelo: "• 1× Vestido (Preto · M) — R$ 289,00". */
export function formatCartLines(cart: readonly BotCartItem[] | undefined): string[] {
  const itens = cart ?? [];
  if (itens.length === 0) return ["Sacola vazia."];
  return [
    ...itens.map(
      (item) =>
        `• ${item.quantidade}× ${cartItemLabel(item)} — ${formatCentsBRL(item.precoCents * item.quantidade)}`,
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
export function renderContextNote(
  state: BotState,
  extras: { lines?: readonly string[] } = {},
): string | null {
  const linhas: string[] = [];

  if (state.displayName?.trim()) {
    linhas.push(`• Nome no WhatsApp: ${state.displayName.trim()}`);
  }
  if (state.notes && state.notes.length > 0) {
    linhas.push(`• Anotações: ${state.notes.join("; ")}`);
  }
  if (state.cart && state.cart.length > 0) {
    linhas.push(
      `• Sacola agora: ${state.cart
        .map((item) => `${item.quantidade}× ${cartItemLabel(item)}`)
        .join(", ")} — subtotal ${formatCentsBRL(cartSubtotalCents(state.cart))}`,
    );
  }
  if (state.focus) {
    linhas.push(
      `• Peça em vista: ${state.focus.nome}${state.focus.cor ? ` (cor ${state.focus.cor})` : ""}`,
    );
  }
  if (state.lastCep) {
    const cotacoes = (state.lastQuotes ?? [])
      .map(
        (quote) =>
          `${quote.name} ${formatCentsBRL(quote.priceCents)} (${formatDays(quote.deliveryDaysMin, quote.deliveryDaysMax)})`,
      )
      .join(", ");
    const escolhido = state.lastQuotes?.find(
      (quote) => quote.rateId === state.chosenRateId,
    );
    // Sacola mudou depois da cotação (adicionar/remover zeram lastQuotes):
    // o CEP fica como pista, mas o frete tem de ser cotado de novo.
    linhas.push(
      cotacoes
        ? `• CEP informado: ${formatCep(state.lastCep)} · frete cotado: ${cotacoes}${escolhido ? ` · escolhido: ${escolhido.name}` : ""}`
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
      `• Cupom validado nesta conversa: ${state.coupon.code} (desconto de ${formatCentsBRL(state.coupon.discountCents)} na sacola de então) — criar_pedido aplica sozinho e recalcula no fechamento; para NÃO usar, passe cupom vazio`,
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
  return [
    "CADERNINHO (memória interna da vendedora sobre esta cliente — contexto, NÃO é fala dela; use sem repetir literalmente):",
    ...linhas,
  ].join("\n");
}
