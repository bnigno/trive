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
    lastCep: z.string().optional(),
    lastQuotes: z.array(quoteSchema).optional(),
    chosenRateId: z.string().optional(),
    lastOrderNumber: z.number().int().optional(),
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

function formatCep(cep: string): string {
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
export function renderContextNote(state: BotState): string | null {
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
    linhas.push(
      `• CEP informado: ${formatCep(state.lastCep)}${cotacoes ? ` · frete cotado: ${cotacoes}` : ""}${escolhido ? ` · escolhido: ${escolhido.name}` : ""}`,
    );
  }
  if (state.lastOrderNumber !== undefined) {
    linhas.push(`• Último pedido nesta conversa: #${state.lastOrderNumber}`);
  }

  if (linhas.length === 0) return null;
  return [
    "CADERNINHO (memória interna da vendedora sobre esta cliente — contexto, NÃO é fala dela; use sem repetir literalmente):",
    ...linhas,
  ].join("\n");
}
