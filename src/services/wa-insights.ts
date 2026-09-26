// Números e atividade da vendedora para a Central do WhatsApp e para o
// "Bom dia da maison": conversas, turnos, transferências, pedidos que ela
// fechou e o custo estimado — tudo derivado da trilha que runBotTurn grava
// em audit_log ('wa.bot_turn' / 'wa.bot_handoff') e dos pedidos do canal.
import { and, desc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { estimateUsageCostUsdCents } from "@/core/ai/model-cost";
import { OUTBOX_SOURCES, type OutboxSource } from "@/core/queue/outbox-source";
import { BOT_UNAVAILABLE_REPLY } from "@/services/bot/shared";
import { summarizeStudioCosts } from "@/services/studio";
import { auditLog, customers, orders, waConversations, waMessages } from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";

const WINDOW_DAYS = 7;

/**
 * Preço por milhão de tokens em CENTAVOS de dólar (Anthropic, 2026):
 * entrada, cache lido (10%), cache gravado por 1 h (2×) e saída.
 */
/** Mesma tabela da ficha pela foto (src/core/ai/model-cost.ts). */
export function estimateUsdCents(
  model: string,
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  },
): number {
  return estimateUsageCostUsdCents(tokens, model);
}

export interface BotActivityWindow {
  /** Conversas com mensagem da cliente na janela. */
  conversations: number;
  turns: number;
  handoffs: number;
  /** Pedidos do canal 'whatsapp' criados na janela (só a vendedora cria por ele). */
  orders: number;
  ordersCents: number;
  costUsdCents: number;
  /** Foto no corpo na janela: imagens geradas (opções e fotos-base) e o gasto delas. */
  studioImages: number;
  studioVideos: number;
  studioUsdCents: number;
}

/** O que a vendedora fez entre `from` (inclusive) e `to` (exclusive). */
export async function summarizeBotActivity(
  db: DbOrTx,
  window: { from: Date; to: Date },
): Promise<BotActivityWindow> {
  const inWindow = (column: typeof auditLog.createdAt) =>
    and(gte(column, window.from), lt(column, window.to));

  const [conversationsRow] = await db
    .select({ value: sql<string>`count(distinct ${waMessages.conversationId})` })
    .from(waMessages)
    .where(
      and(
        eq(waMessages.direction, "inbound"),
        gte(waMessages.createdAt, window.from),
        lt(waMessages.createdAt, window.to),
      ),
    );

  const usageRows = await db
    .select({
      model: sql<string | null>`${auditLog.after} ->> 'model'`,
      turns: sql<string>`count(*)`,
      inputTokens: sql<string>`coalesce(sum((${auditLog.after} -> 'usage' ->> 'inputTokens')::bigint), 0)`,
      outputTokens: sql<string>`coalesce(sum((${auditLog.after} -> 'usage' ->> 'outputTokens')::bigint), 0)`,
      cacheReadTokens: sql<string>`coalesce(sum((${auditLog.after} -> 'usage' ->> 'cacheReadTokens')::bigint), 0)`,
      cacheWriteTokens: sql<string>`coalesce(sum((${auditLog.after} -> 'usage' ->> 'cacheWriteTokens')::bigint), 0)`,
    })
    .from(auditLog)
    // A ficha pela foto grava o mesmo formato de `usage`: o painel soma as duas.
    .where(
      and(
        inArray(auditLog.action, ["wa.bot_turn", "product.draft_from_photos"]),
        inWindow(auditLog.createdAt),
      ),
    )
    .groupBy(sql`1`);

  let turns = 0;
  let costUsdCents = 0;
  for (const row of usageRows) {
    turns += Number(row.turns);
    costUsdCents += estimateUsdCents(row.model ?? "claude-sonnet-5", {
      inputTokens: Number(row.inputTokens),
      outputTokens: Number(row.outputTokens),
      cacheReadTokens: Number(row.cacheReadTokens),
      cacheWriteTokens: Number(row.cacheWriteTokens),
    });
  }

  const [handoffs] = await db
    .select({ value: sql<string>`count(*)` })
    .from(auditLog)
    .where(and(eq(auditLog.action, "wa.bot_handoff"), inWindow(auditLog.createdAt)));

  const [botOrders] = await db
    .select({
      value: sql<string>`count(*)`,
      totalCents: sql<string>`coalesce(sum(${orders.totalCents}), 0)`,
    })
    .from(orders)
    .where(
      and(
        eq(orders.channel, "whatsapp"),
        gte(orders.createdAt, window.from),
        lt(orders.createdAt, window.to),
      ),
    );

  const studio = await summarizeStudioCosts(db, window);

  return {
    conversations: Number(conversationsRow?.value ?? 0),
    turns,
    handoffs: Number(handoffs?.value ?? 0),
    orders: Number(botOrders?.value ?? 0),
    ordersCents: Number(botOrders?.totalCents ?? 0),
    costUsdCents,
    studioImages: studio.images,
    studioVideos: studio.videos,
    studioUsdCents: studio.usdCents,
  };
}

export interface BotActivitySummary {
  windowDays: number;
  /** Conversas com mensagem da cliente hoje (fuso de São Paulo). */
  conversationsToday: number;
  turns: number;
  handoffs: number;
  /** Pedidos do canal 'whatsapp' (só a vendedora cria por esse canal). */
  ordersByBot: number;
  ordersByBotCents: number;
  estimatedCostUsdCents: number;
  /** Foto no corpo na janela: imagens e vídeos gerados e o gasto deles (separado da Lia). */
  studioImages: number;
  studioVideos: number;
  studioUsdCents: number;
}

export async function getBotActivitySummary(db: DbOrTx): Promise<BotActivitySummary> {
  const now = new Date();
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);

  const [today] = await db
    .select({ value: sql<string>`count(*)` })
    .from(waConversations)
    .where(
      sql`${waConversations.lastInboundAt} >= (date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo')`,
    );

  const window = await summarizeBotActivity(db, {
    from: since,
    to: new Date(now.getTime() + 60_000),
  });

  return {
    windowDays: WINDOW_DAYS,
    conversationsToday: Number(today?.value ?? 0),
    turns: window.turns,
    handoffs: window.handoffs,
    ordersByBot: window.orders,
    ordersByBotCents: window.ordersCents,
    estimatedCostUsdCents: window.costUsdCents,
    studioImages: window.studioImages,
    studioVideos: window.studioVideos,
    studioUsdCents: window.studioUsdCents,
  };
}

/** Percentis de cada trecho do turno, em ms (null quando não há amostra). */
export interface BotTimingSplit {
  queueWaitMs: number | null;
  prepMs: number | null;
  modelMs: number | null;
  deliveryMs: number | null;
  totalMs: number | null;
  inboundToFirstBubbleMs: number | null;
}

export interface BotResponseTimes {
  windowDays: number;
  /** Respostas medidas na janela (turnos autônomos que entregaram um balão). */
  turns: number;
  p50: BotTimingSplit;
  p90: BotTimingSplit;
  /** Médias — são elas que somam (a barra "onde o tempo foi"); medianas não somam. */
  mean: BotTimingSplit;
  /** Quantas dessas respostas saíram na hora (inline), pelo aviso ao Inngest (kick) ou pelo cron. */
  bySource: Record<OutboxSource | "unknown", number>;
  /** Mensagem dela → primeiro balão ENTREGUE no celular (recibo da Z-API), pela junção do dedupe da resposta com a inbound. */
  delivered: { turns: number; p50Ms: number | null; p90Ms: number | null };
}

const TIMING_FIELDS = [
  "queueWaitMs",
  "prepMs",
  "modelMs",
  "deliveryMs",
  "totalMs",
  "inboundToFirstBubbleMs",
] as const;

/**
 * Quanto a Lia demora, de verdade: mediana, p90 e média de cada trecho do
 * turno (fila, preparo, modelo, entrega) nos últimos 7 dias, a partir dos
 * `timings` que runBotTurn grava no audit. Só turnos autônomos (em copiloto
 * quem responde é a dona) e só os que já têm a medição; nulls (trecho que
 * não houve) ficam fora de cada agregado. Turnos que caíram no plano B
 * (wa.bot_turn_failed) não entram — o card mede respostas da Lia.
 */
export async function getBotResponseTimes(db: DbOrTx): Promise<BotResponseTimes> {
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000);
  const timing = (field: (typeof TIMING_FIELDS)[number]) =>
    sql`(${auditLog.after} -> 'timings' ->> ${field})::numeric`;
  const percentile = (q: number, field: (typeof TIMING_FIELDS)[number]) =>
    sql<string | null>`percentile_cont(${q}) within group (order by ${timing(field)})`;
  const measured = sql`${timing("inboundToFirstBubbleMs")} is not null`;
  const sourceOf = sql`${auditLog.after} -> 'timings' ->> 'source'`;
  const selection: Record<string, ReturnType<typeof percentile> | ReturnType<typeof sql<string>>> = {
    turns: sql<string>`count(*) filter (where ${measured})`,
    src_unknown: sql<string>`count(*) filter (where ${measured} and ${sourceOf} is null)`,
  };
  for (const source of OUTBOX_SOURCES) {
    selection[`src_${source}`] = sql<string>`count(*) filter (where ${measured} and ${sourceOf} = ${source})`;
  }
  for (const field of TIMING_FIELDS) {
    selection[`p50_${field}`] = percentile(0.5, field);
    selection[`p90_${field}`] = percentile(0.9, field);
    selection[`mean_${field}`] = sql<string | null>`avg(${timing(field)})`;
  }
  const [row] = await db
    .select(selection)
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "wa.bot_turn"),
        gte(auditLog.createdAt, since),
        sql`${auditLog.after} ->> 'mode' = 'autonomous'`,
        sql`${auditLog.after} ? 'timings'`,
      ),
    );
  const pick = (prefix: "p50" | "p90" | "mean"): BotTimingSplit => {
    const split = {} as Record<(typeof TIMING_FIELDS)[number], number | null>;
    for (const field of TIMING_FIELDS) {
      const value = row?.[`${prefix}_${field}`];
      split[field] = value === null || value === undefined ? null : Math.round(Number(value));
    }
    return split;
  };
  const bySource: Record<OutboxSource | "unknown", number> = { inline: 0, kick: 0, cron: 0, unknown: 0 };
  for (const source of [...OUTBOX_SOURCES, "unknown"] as const) bySource[source] = Number(row?.[`src_${source}`] ?? 0);

  // O que a cliente sentiu: da mensagem dela ao primeiro balão ENTREGUE (o
  // callback de status da Z-API grava delivered_at). A resposta da Lia tem
  // dedupe 'wa.bot_reply:<id da inbound>' — é essa a junção. O aviso do plano
  // B usa o mesmo dedupe e fica de fora: não é resposta da Lia.
  const deliveredMs = sql`extract(epoch from (${waMessages.deliveredAt} - ${inboundOf.createdAt})) * 1000`;
  const [deliveredRow] = await db
    .select({
      turns: sql<string>`count(*)`,
      p50: sql<string | null>`percentile_cont(0.5) within group (order by ${deliveredMs})`,
      p90: sql<string | null>`percentile_cont(0.9) within group (order by ${deliveredMs})`,
    })
    .from(waMessages)
    .innerJoin(inboundOf, sql`${waMessages.dedupeKey} = 'wa.bot_reply:' || ${inboundOf.id}::text`)
    .where(
      and(
        eq(waMessages.direction, "outbound"),
        sql`${waMessages.deliveredAt} is not null`,
        ne(waMessages.body, BOT_UNAVAILABLE_REPLY),
        gte(waMessages.createdAt, since),
      ),
    );
  const ms = (value: string | null | undefined) => (value === null || value === undefined ? null : Math.round(Number(value)));

  return {
    windowDays: WINDOW_DAYS,
    turns: Number(row?.turns ?? 0),
    p50: pick("p50"),
    p90: pick("p90"),
    mean: pick("mean"),
    bySource,
    delivered: { turns: Number(deliveredRow?.turns ?? 0), p50Ms: ms(deliveredRow?.p50), p90Ms: ms(deliveredRow?.p90) },
  };
}

/** A inbound que uma resposta da Lia respondeu (alias para a autojunção de wa_messages). */
const inboundOf = alias(waMessages, "inbound_of");

export interface BotActivityEvent {
  kind: "handoff" | "order";
  at: Date;
  conversationId: string | null;
  /** Nome da cliente ou telefone (quem lê mascara). */
  who: string | null;
  phoneE164: string | null;
  title: string;
  detail: string | null;
  orderId: string | null;
}

/** Últimas transferências (com motivo e resumo) e pedidos fechados pela vendedora. */
export async function listRecentBotActivity(
  db: DbOrTx,
  options: { limit?: number } = {},
): Promise<BotActivityEvent[]> {
  const limit = options.limit ?? 10;

  const handoffRows = await db
    .select({
      at: auditLog.createdAt,
      conversationId: waConversations.id,
      phoneE164: waConversations.phoneE164,
      customerName: customers.fullName,
      after: auditLog.after,
    })
    .from(auditLog)
    .innerJoin(
      waConversations,
      sql`${waConversations.id}::text = ${auditLog.entityId}`,
    )
    .leftJoin(customers, eq(customers.id, waConversations.customerId))
    .where(eq(auditLog.action, "wa.bot_handoff"))
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);

  const orderRows = await db
    .select({
      at: orders.createdAt,
      id: orders.id,
      orderNumber: orders.orderNumber,
      totalCents: orders.totalCents,
      status: orders.status,
      customerName: customers.fullName,
      phoneE164: customers.phoneE164,
    })
    .from(orders)
    .leftJoin(customers, eq(customers.id, orders.customerId))
    .where(eq(orders.channel, "whatsapp"))
    .orderBy(desc(orders.createdAt))
    .limit(limit);

  const events: BotActivityEvent[] = [
    ...handoffRows.map((row) => {
      const after = (row.after ?? {}) as { motivo?: string; resumo?: string };
      return {
        kind: "handoff" as const,
        at: row.at,
        conversationId: row.conversationId,
        who: row.customerName,
        phoneE164: row.phoneE164,
        title: after.motivo?.trim() || "Passou a conversa para você",
        detail: after.resumo?.trim() || null,
        orderId: null,
      };
    }),
    ...orderRows.map((row) => ({
      kind: "order" as const,
      at: row.at,
      conversationId: null,
      who: row.customerName,
      phoneE164: row.phoneE164,
      title: `Pedido #${row.orderNumber}`,
      detail: null,
      orderId: row.id,
    })),
  ];
  events.sort((a, b) => b.at.getTime() - a.at.getTime());
  return events.slice(0, limit);
}
