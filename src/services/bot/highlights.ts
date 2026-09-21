// Destaques do catálogo para o caderninho da Lia: o que chegou nos últimos
// dias e o que mais vendeu no mês — só NOMES, para puxar assunto ("chegou o
// Longo Dunas essa semana"). Preço, estoque e detalhes continuam vindo das
// ferramentas. Fato do dia: vai no caderninho (por turno), não no prompt.
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";

import { orderItems, orders, products, productVariants } from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { paidCondition } from "@/services/reports";
import { publiclyVisible } from "@/services/store-catalog";

export const NEW_ARRIVALS_DAYS = 14;
export const BEST_SELLERS_DAYS = 30;
export const HIGHLIGHTS_MAX = 5;

/** Peça pública COM estoque em alguma variação vendável — o mesmo "disponível" de listPublicProducts, em SQL, sem lista de ids. */
function availableProduct(now: Date) {
  return and(
    eq(products.status, "active"),
    isNull(products.deletedAt),
    publiclyVisible(undefined, now),
    sql`exists (
      select 1 from product_variants pv
      join price_versions pr on pr.product_variant_id = pv.id and pr.status = 'active'
      left join stock_levels sl on sl.product_variant_id = pv.id
      where pv.product_id = ${products.id} and pv.is_active = true and pv.deleted_at is null
        and coalesce(sl.on_hand, 0) - coalesce(sl.reserved, 0) > 0
    )`,
  );
}

/** Até duas linhas: "Novidades (últimos 14 dias): A, B" e "Mais vendidas (30 dias): X, Y". Vazio quando não há. */
export async function catalogHighlightLines(db: DbOrTx, now: Date): Promise<string[]> {
  const lines: string[] = [];

  const novidades = await db
    .select({ name: products.name })
    .from(products)
    .where(and(availableProduct(now), gte(products.createdAt, new Date(now.getTime() - NEW_ARRIVALS_DAYS * 86_400_000))))
    .orderBy(desc(products.createdAt))
    .limit(HIGHLIGHTS_MAX);
  if (novidades.length > 0) {
    lines.push(`Novidades (últimos ${NEW_ARRIVALS_DAYS} dias): ${novidades.map((item) => item.name).join(", ")}`);
  }

  // Por PRODUTO (nunca por variação, nunca SKU): unidades pagas no período, depois receita —
  // sobre TODO o catálogo disponível, não só as peças mais novas.
  const units = sql<string>`sum(${orderItems.quantity})`;
  const revenue = sql<string>`sum(${orderItems.totalCents})`;
  const rows = await db
    .select({ id: products.id, name: products.name, units, revenue })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .innerJoin(productVariants, eq(productVariants.id, orderItems.productVariantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(and(paidCondition(), gte(orders.paidAt, new Date(now.getTime() - BEST_SELLERS_DAYS * 86_400_000)), availableProduct(now)))
    .groupBy(products.id, products.name)
    .orderBy(desc(units), desc(revenue))
    .limit(HIGHLIGHTS_MAX);
  if (rows.length > 0) {
    lines.push(`Mais vendidas (${BEST_SELLERS_DAYS} dias): ${rows.map((row) => row.name).join(", ")}`);
  }
  return lines;
}
