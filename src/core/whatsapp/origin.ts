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
 * A inbound que uma saída da Lia respondeu, pelo dedupe determinístico
 * (`wa.bot_reply:<inboundId>[:n]`, `wa.bot_media:<inboundId>:n|card`,
 * `wa.bot_handoff_notice:<inboundId>`). Retorno combinado (`followup:`),
 * sugestão do copiloto (`suggestion:`) e envios da equipe/automação não
 * apontam para nenhuma.
 */
export function answeredInboundId(dedupeKey: string | null | undefined): string | null {
  if (typeof dedupeKey !== "string") return null;
  const bot = /^wa\.bot_(?:reply|media|handoff_notice):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?::.+)?$/i.exec(dedupeKey);
  if (bot) return bot[1];
  // Resposta da equipe pelo painel: `:re:<inbound>` é a última mensagem da
  // cliente que estava na tela quando a dona clicou Enviar.
  const manual = /^wa\.send:.+:re:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(dedupeKey);
  return manual ? manual[1] : null;
}

/** Dedupe de uma resposta manual ancorada na última mensagem da cliente vista na tela. */
export function manualReplyDedupeKey(sendId: string, lastSeenInboundId: string | null): string {
  return lastSeenInboundId ? `wa.send:${sendId}:re:${lastSeenInboundId}` : `wa.send:${sendId}`;
}

export interface HistoryRowOrder {
  id: string;
  direction: string;
  dedupeKey: string | null;
  templateKey?: string | null;
  createdAt: Date;
  /** A inbound respondida quando o dedupe não a carrega (sugestão aprovada no copiloto: vem da tabela de sugestões). */
  answers?: string | null;
  /** Resposta manual: a hora em que a dona clicou Enviar (a linha nasce quando a fila entrega, segundos depois). */
  repliedAt?: Date | null;
}

/** A inbound que esta saída respondeu: a informada, senão a do dedupe. */
export function answeredInboundOf(row: Pick<HistoryRowOrder, "direction" | "dedupeKey" | "answers">): string | null {
  if (row.direction === "inbound") return null;
  return row.answers ?? answeredInboundId(row.dedupeKey);
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
  let lastInboundAt = -Infinity;
  let lastInboundId: string | null = null;
  for (const row of rows) {
    if (row.direction !== "inbound") continue;
    inboundAt.set(row.id, row.createdAt.getTime());
    if (row.createdAt.getTime() >= lastInboundAt) {
      lastInboundAt = row.createdAt.getTime();
      lastInboundId = row.id;
    }
  }
  // A última mensagem dela já tem resposta ancorada? Então nada precisa ser
  // puxado para antes dela: a conversa não termina "pendente".
  const lastInboundAnswered = lastInboundId !== null && rows.some((row) => answeredInboundOf(row) === lastInboundId);
  const keyed = rows.map((row, index) => {
    const answered = answeredInboundOf(row);
    const anchor = answered !== null ? inboundAt.get(answered) : undefined;
    // A resposta cola na inbound (mesmo instante, desempate depois dela).
    if (anchor !== undefined) return { row, index, at: anchor, after: 1 };
    // Saída DA LIA sem inbound conhecida (cartão de turno antigo, retorno
    // combinado) que saiu DEPOIS da última mensagem da cliente não respondeu a
    // ela — ela pode ter chegado enquanto o modelo pensava: fica logo antes, e
    // a conversa termina com a cliente. Aviso e mensagem da equipe viram fala
    // de usuário e ficam na ordem em que saíram.
    const origin = row.direction === "inbound" ? "customer" : deriveWaMessageOrigin({ direction: row.direction, dedupeKey: row.dedupeKey, templateKey: row.templateKey ?? null });
    if (origin === "bot" && !lastInboundAnswered && row.createdAt.getTime() >= lastInboundAt) return { row, index, at: lastInboundAt, after: -1 };
    return { row, index, at: row.createdAt.getTime(), after: 0 };
  });
  keyed.sort((a, b) => a.at - b.at || a.after - b.after || a.index - b.index);
  return keyed.map((k) => k.row);
}

/**
 * Mensagens da cliente ainda sem resposta: uma saída da Lia ancorada numa
 * inbound cobre tudo até ela (inclusive); uma resposta manual da equipe
 * cobre tudo que veio antes dela. Aviso automático, cartão de turno antigo e
 * retorno combinado não cobrem nada. É o que decide se o turno roda e quais
 * fotos/áudios vão anexados ao modelo.
 */
export function pendingInboundRows<T extends HistoryRowOrder>(rows: readonly T[]): T[] {
  const inboundAt = new Map<string, number>();
  for (const row of rows) if (row.direction === "inbound") inboundAt.set(row.id, row.createdAt.getTime());
  let coveredUntil = -Infinity;
  for (const row of rows) {
    if (row.direction === "inbound") continue;
    const answered = answeredInboundOf(row);
    if (answered !== null) {
      const at = inboundAt.get(answered);
      if (at !== undefined) coveredUntil = Math.max(coveredUntil, at);
      continue;
    }
    if (deriveWaMessageOrigin({ direction: row.direction, dedupeKey: row.dedupeKey, templateKey: row.templateKey ?? null }) === "manual") {
      // Resposta manual sem âncora (painel antigo, envio pelo celular da loja):
      // vale para o que chegou antes do clique — não o que a fila entregou depois.
      coveredUntil = Math.max(coveredUntil, (row.repliedAt ?? row.createdAt).getTime() - 1);
    }
  }
  return rows.filter((row) => row.direction === "inbound" && row.createdAt.getTime() > coveredUntil);
}
