// Origem de uma mensagem do WhatsApp para exibição no painel: quem "falou" —
// o cliente, o robô de vendas, o dono (resposta manual) ou uma automação
// (notificação de pedido, aviso de estoque etc.). Derivada de dados que a
// mensagem já carrega; nada é gravado a mais no banco.
export type WaMessageOrigin = "customer" | "bot" | "manual" | "auto";

export interface DeriveWaMessageOriginInput {
  direction: string;
  templateKey: string | null;
  dedupeKey: string | null;
}

/**
 * A ordem dos testes importa e é contrato:
 * 1. inbound → customer (tudo que chega é do cliente);
 * 2. dedupe `wa.bot_*` → bot (reply/media/handoff_notice do robô);
 * 3. dedupe `wa.send:` → manual (exclusivo do envio do dono pelo painel);
 * 4. templateKey presente → auto (notificações de pedido/estoque);
 * 5. fallback → auto (outbound sem assinatura conhecida).
 */
/** Resposta que a Lia mandou por conta (retorno combinado/retomada): dedupe `wa.bot_reply:followup:<id>`. */
export function isProactiveBotReply(dedupeKey: string | null | undefined): boolean {
  return typeof dedupeKey === "string" && /^wa\.bot_reply:followup:/.test(dedupeKey);
}

export function deriveWaMessageOrigin(
  input: DeriveWaMessageOriginInput,
): WaMessageOrigin {
  if (input.direction === "inbound") return "customer";
  if (input.dedupeKey?.startsWith("wa.bot_")) return "bot";
  if (input.dedupeKey?.startsWith("wa.send:")) return "manual";
  if (input.templateKey) return "auto";
  return "auto";
}

/**
 * A inbound que uma resposta da Lia respondeu, pelo dedupe determinístico
 * (`wa.bot_reply:<inboundId>[:n]`, `wa.bot_media:<inboundId>:n`). Retorno
 * combinado (`followup:`) e envios da equipe/automação não respondem a nada.
 */
export function answeredInboundId(dedupeKey: string | null | undefined): string | null {
  if (typeof dedupeKey !== "string") return null;
  const match = /^wa\.bot_(?:reply|media):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?::\d+)?$/i.exec(dedupeKey);
  return match ? match[1] : null;
}

export interface HistoryRowOrder {
  id: string;
  direction: string;
  dedupeKey: string | null;
  createdAt: Date;
}

/**
 * Ordem do histórico para o modelo: cada resposta da Lia vai logo depois da
 * inbound que ela respondeu, não na hora em que saiu. Uma mensagem da
 * cliente que chegou ENQUANTO o modelo pensava fica depois da resposta —
 * ela ainda não foi respondida, e a conversa termina com a cliente (a API
 * recusa histórico que termina com a assistente). Ordem estável no resto.
 */
export function orderHistoryRows<T extends HistoryRowOrder>(rows: readonly T[]): T[] {
  const inboundAt = new Map<string, number>();
  for (const row of rows) if (row.direction === "inbound") inboundAt.set(row.id, row.createdAt.getTime());
  const keyed = rows.map((row, index) => {
    const answered = row.direction === "inbound" ? null : answeredInboundId(row.dedupeKey);
    const anchor = answered !== null ? inboundAt.get(answered) : undefined;
    // A resposta cola na inbound (mesmo instante, desempate depois dela); sem inbound conhecida, fica onde saiu.
    return { row, index, at: anchor ?? row.createdAt.getTime(), after: anchor !== undefined ? 1 : 0 };
  });
  keyed.sort((a, b) => a.at - b.at || a.after - b.after || a.index - b.index);
  return keyed.map((k) => k.row);
}
