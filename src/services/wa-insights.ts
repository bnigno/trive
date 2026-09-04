// Números e atividade da vendedora para a Central do WhatsApp: conversas de
// hoje, turnos, transferências, pedidos que ela fechou e o custo estimado
// dos últimos 7 dias — tudo derivado da trilha que runBotTurn grava em
// audit_log ('wa.bot_turn' / 'wa.bot_handoff') e dos pedidos do canal.
import { and, desc, eq, gte, sql } from "drizzle-orm";

import { auditLog, customers, orders, waConversations } from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";

const WINDOW_DAYS = 7;

/**
 * Preço por milhão de tokens em CENTAVOS de dólar (Anthropic, 2026):
 * entrada, cache lido (10%), cache gravado por 1 h (2×) e saída.
 */
const PRICE_USD_CENTS_PER_MTOK: Record<
  string,
  { input: number; cacheRead: number; cacheWrite: number; output: number }
> = {
  "claude-sonnet-5": { input: 300, cacheRead: 30, cacheWrite: 600, output: 1500 },
  "claude-haiku-4-5": { input: 100, cacheRead: 10, cacheWrite: 200, output: 500 },
  "claude-opus-5": { input: 500, cacheRead: 50, cacheWrite: 1000, output: 2500 },
};

/** Custo em centavos de dólar de um conjunto de tokens num modelo. */
export function estimateUsdCents(
  model: string,
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  },
): number {
  const price =
    PRICE_USD_CENTS_PER_MTOK[model] ?? PRICE_USD_CENTS_PER_MTOK["claude-sonnet-5"];
  const total =
    tokens.inputTokens * price.input +
    tokens.cacheReadTokens * price.cacheRead +
    tokens.cacheWriteTokens * price.cacheWrite +
    tokens.outputTokens * price.output;
  return Math.round(total / 1_000_000);
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
}

function windowStart(): Date {
  return new Date(Date.now() - WINDOW_DAYS * 86_400_000);
}

export async function getBotActivitySummary(db: DbOrTx): Promise<BotActivitySummary> {
  const since = windowStart();

  const [today] = await db
    .select({ value: sql<string>`count(*)` })
    .from(waConversations)
    .where(
      sql`${waConversations.lastInboundAt} >= (date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo')`,
    );

  const usageRows = await db
    .select({
      model: sql<string | null>`${auditLog.after} ->> 'model'`,
      turns: sql<string>`count(*)`,
      handedOff: sql<string>`count(*) filter (where (${auditLog.after} ->> 'handedOff') = 'true')`,
      inputTokens: sql<string>`coalesce(sum((${auditLog.after} -> 'usage' ->> 'inputTokens')::bigint), 0)`,
      outputTokens: sql<string>`coalesce(sum((${auditLog.after} -> 'usage' ->> 'outputTokens')::bigint), 0)`,
      cacheReadTokens: sql<string>`coalesce(sum((${auditLog.after} -> 'usage' ->> 'cacheReadTokens')::bigint), 0)`,
      cacheWriteTokens: sql<string>`coalesce(sum((${auditLog.after} -> 'usage' ->> 'cacheWriteTokens')::bigint), 0)`,
    })
    .from(auditLog)
    .where(and(eq(auditLog.action, "wa.bot_turn"), gte(auditLog.createdAt, since)))
    .groupBy(sql`1`);

  let turns = 0;
  let estimatedCostUsdCents = 0;
  for (const row of usageRows) {
    turns += Number(row.turns);
    estimatedCostUsdCents += estimateUsdCents(row.model ?? "claude-sonnet-5", {
      inputTokens: Number(row.inputTokens),
      outputTokens: Number(row.outputTokens),
      cacheReadTokens: Number(row.cacheReadTokens),
      cacheWriteTokens: Number(row.cacheWriteTokens),
    });
  }

  const [handoffs] = await db
    .select({ value: sql<string>`count(*)` })
    .from(auditLog)
    .where(and(eq(auditLog.action, "wa.bot_handoff"), gte(auditLog.createdAt, since)));

  const [botOrders] = await db
    .select({
      value: sql<string>`count(*)`,
      totalCents: sql<string>`coalesce(sum(${orders.totalCents}), 0)`,
    })
    .from(orders)
    .where(and(eq(orders.channel, "whatsapp"), gte(orders.createdAt, since)));

  return {
    windowDays: WINDOW_DAYS,
    conversationsToday: Number(today?.value ?? 0),
    turns,
    handoffs: Number(handoffs?.value ?? 0),
    ordersByBot: Number(botOrders?.value ?? 0),
    ordersByBotCents: Number(botOrders?.totalCents ?? 0),
    estimatedCostUsdCents,
  };
}

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
