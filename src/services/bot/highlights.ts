// Destaques do catálogo para o caderninho da Lia: o que chegou nos últimos
// dias e o que mais vendeu no mês — só NOMES, para puxar assunto ("chegou o
// Longo Dunas essa semana"). Preço, estoque e detalhes continuam vindo das
// ferramentas. Fato do dia: vai no caderninho (por turno), não no prompt.
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";

import { orderItems, orders, products, productVariants } from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { paidCondition } from "@/services/reports";
import type { ServiceDb } from "@/services/settings";
import { listPublicProducts } from "@/services/store-catalog";

export const NEW_ARRIVALS_DAYS = 14;
export const BEST_SELLERS_DAYS = 30;
export const HIGHLIGHTS_MAX = 5;

/** Até duas linhas: "Novidades (últimos 14 dias): A, B" e "Mais vendidas (30 dias): X, Y". Vazio quando não há. */
export async function catalogHighlightLines(db: DbOrTx, now: Date): Promise<string[]> {
  // Já ordenadas da mais nova para a mais antiga; só peças com estoque valem destaque.
  const available = (await listPublicProducts(db as unknown as ServiceDb, { limit: 200 })).filter((item) => item.available);
  if (available.length === 0) return [];

  const lines: string[] = [];
  const arrivedSince = now.getTime() - NEW_ARRIVALS_DAYS * 86_400_000;
  const novidades = available.filter((item) => item.createdAt !== undefined && item.createdAt.getTime() >= arrivedSince).slice(0, HIGHLIGHTS_MAX);
  if (novidades.length > 0) {
    lines.push(`Novidades (últimos ${NEW_ARRIVALS_DAYS} dias): ${novidades.map((item) => item.name).join(", ")}`);
  }

  // Por PRODUTO (nunca por variação, nunca SKU): unidades pagas no período, depois receita.
  const units = sql<string>`sum(${orderItems.quantity})`;
  const revenue = sql<string>`sum(${orderItems.totalCents})`;
  const rows = await db
    .select({ id: products.id, name: products.name, units, revenue })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .innerJoin(productVariants, eq(productVariants.id, orderItems.productVariantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(
      and(
        paidCondition(),
        gte(orders.paidAt, new Date(now.getTime() - BEST_SELLERS_DAYS * 86_400_000)),
        inArray(
          products.id,
          available.map((item) => item.id),
        ),
      ),
    )
    .groupBy(products.id, products.name)
    .orderBy(desc(units), desc(revenue))
    .limit(HIGHLIGHTS_MAX);
  if (rows.length > 0) {
    lines.push(`Mais vendidas (${BEST_SELLERS_DAYS} dias): ${rows.map((row) => row.name).join(", ")}`);
  }
  return lines;
}
