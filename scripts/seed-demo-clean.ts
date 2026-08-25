// Oculta os dados de demonstração criados por seed-demo.ts: arquiva os
// produtos DEMO-* (somem da loja; histórico preservado por design) e faz
// soft-delete dos clientes marcados 'seed-demo' sem pedidos.
// Uso: npx tsx --env-file=.env.prod.local scripts/seed-demo-clean.ts
import { eq, like, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";

async function main() {
  const db = getDb();

  const demoProducts = await db
    .selectDistinct({ productId: schema.productVariants.productId })
    .from(schema.productVariants)
    .where(like(schema.productVariants.sku, "DEMO-%"));
  for (const { productId } of demoProducts) {
    await db.update(schema.products).set({ status: "archived" }).where(eq(schema.products.id, productId));
  }
  console.log(`Produtos de demonstração arquivados: ${demoProducts.length} (somem da loja; histórico preservado).`);

  const res = await db.execute(sql`
    update customers set deleted_at = now()
    where notes = 'seed-demo' and deleted_at is null
      and not exists (select 1 from orders where orders.customer_id = customers.id)
  `);
  const count = Array.isArray(res) ? res.length : ((res as { rowCount?: number }).rowCount ?? 0);
  console.log(`Clientes de demonstração ocultados: ${count} (os com pedidos reais são mantidos).`);

  await db.update(schema.coupons).set({ isActive: false }).where(eq(schema.coupons.code, "BEMVINDO10"));
  console.log("Cupom BEMVINDO10 desativado.");
  console.log("Limpeza concluída.");
  process.exit(0);
}

main().catch((e) => { console.error("FALHOU:", e); process.exit(1); });
