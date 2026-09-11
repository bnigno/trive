// O que a cliente já comprou, em texto para a vendedora — PURO.
//
// A ferramenta historico_de_compras devolve os últimos pedidos do telefone
// da conversa (número, data, status, peças); o caderninho ganha uma linha só
// com as compras de verdade (pagas ou entregues). Pedido cancelado ou ainda
// sem pagamento aparece na lista, mas nunca vira "ela já comprou".

import { formatCentsBRL } from "@/lib/money";

/** Status de pedido nas palavras da vendedora (minúsculas, para o meio da frase). */
export const BOT_ORDER_STATUS_LABELS: Record<string, string> = {
  draft: "em rascunho",
  pending_payment: "aguardando pagamento",
  paid: "pagamento aprovado",
  preparing: "em preparação",
  shipped: "enviado",
  delivered: "entregue",
  canceled: "cancelado",
  refunded: "reembolsado",
};

/** Status em que a compra aconteceu de fato: pagou, está a caminho ou chegou. */
export const PURCHASED_STATUSES = ["paid", "preparing", "shipped", "delivered"] as const;

export function isPurchasedStatus(status: string): boolean {
  return (PURCHASED_STATUSES as readonly string[]).includes(status);
}

/** Quantos pedidos a ferramenta lista, do mais novo ao mais antigo. */
export const PURCHASE_HISTORY_LIMIT = 5;

/** Peças da linha do caderninho: além disso vira "e mais N". */
export const MEMORY_LINE_MAX_ITEMS = 3;

export type PurchaseItem = {
  /** Nome da peça como estava no pedido (snapshot). */
  name: string;
  /** "Areia · M"; vazio para peça sem variação. */
  variantLabel: string;
  quantity: number;
};

export type PurchaseOrderSummary = {
  orderNumber: number;
  status: string;
  createdAt: Date;
  totalCents: number;
  items: PurchaseItem[];
};

const dateFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

/** "11/09/2026" no dia de São Paulo. */
export function formatPurchaseDate(date: Date): string {
  return dateFormatter.format(date);
}

/** "2× Longo Dunas (Areia · M)". */
export function purchaseItemLabel(item: PurchaseItem): string {
  const nome = item.variantLabel ? `${item.name} (${item.variantLabel})` : item.name;
  return `${item.quantity}× ${nome}`;
}

export const NO_PURCHASES_TEXT =
  "Nenhum pedido registrado para este número de WhatsApp — é a primeira compra dela por aqui (ou ela comprou com outro telefone). Não diga que a loja não guarda cadastro: só não há compra neste número.";

/**
 * Bloco devolvido por historico_de_compras: uma linha por pedido, do mais
 * novo ao mais antigo, e uma anotação interna (entre colchetes) dizendo se
 * há compra de verdade para apoiar a venda.
 */
export function summarizePurchaseHistory(orders: readonly PurchaseOrderSummary[]): string {
  if (orders.length === 0) return NO_PURCHASES_TEXT;
  const cabecalho =
    orders.length === 1
      ? "Pedido desta cliente (o mais recente):"
      : `Pedidos desta cliente (os ${orders.length} mais recentes, do mais novo ao mais antigo):`;
  const linhas = orders.map((order) => {
    const pecas = order.items.length > 0 ? order.items.map(purchaseItemLabel).join(", ") : "sem peças";
    return `• #${order.orderNumber} — ${formatPurchaseDate(order.createdAt)} — ${BOT_ORDER_STATUS_LABELS[order.status] ?? order.status} — ${formatCentsBRL(order.totalCents)}: ${pecas}`;
  });
  const compradas = orders.filter((order) => isPurchasedStatus(order.status));
  const nota =
    compradas.length > 0
      ? "[Só pedidos deste telefone. Peças pagas ou entregues são a base para lembrar o tamanho dela e para montar_look; pedido cancelado ou aguardando pagamento não é compra feita.]"
      : "[Só pedidos deste telefone. Nenhum deles foi pago: não trate como compra feita.]";
  return [cabecalho, ...linhas, nota].join("\n");
}

/**
 * Linha do caderninho: só compras de verdade. `latest` é a compra paga mais
 * recente (com as peças) e `total` quantas compras pagas o telefone tem.
 */
export function purchaseMemoryLine(
  latest: PurchaseOrderSummary | null | undefined,
  total: number,
): string | null {
  if (!latest || total <= 0 || !isPurchasedStatus(latest.status)) return null;
  const contagem = total === 1 ? "1 compra" : `${total} compras`;
  const mostradas = latest.items.slice(0, MEMORY_LINE_MAX_ITEMS).map(purchaseItemLabel);
  const restantes = latest.items.length - mostradas.length;
  const pecas =
    mostradas.length > 0
      ? `${mostradas.join(", ")}${restantes > 0 ? ` e mais ${restantes}` : ""}`
      : "sem peças";
  return `Compras anteriores: ${contagem} — última #${latest.orderNumber} (${formatPurchaseDate(latest.createdAt)}): ${pecas}`;
}
