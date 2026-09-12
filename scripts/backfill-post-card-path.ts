// Peças que já estavam ativas antes da prévia do link existir (migração 0023)
// não têm products.post_card_path: o link colado no WhatsApp ainda mostra a
// foto crua. Este script enfileira um product.card_refresh por peça ativa sem
// cartão; a fila desenha (ou reaproveita do cache) e grava o caminho. Roda de
// novo sem efeito: só entra quem ainda está sem caminho.
// Uso (env no shell, como os demais scripts):
//   DATABASE_URL=... INNGEST_EVENT_KEY=... npx tsx scripts/backfill-post-card-path.ts
import { and, eq, isNull } from "drizzle-orm";

import { getDb } from "@/db/client";
import { products } from "@/db/schema";
import { enqueueProductCardRefresh } from "@/services/product-cards-queue";

async function main() {
  const db = getDb();
  const rows = await db
    .select({ id: products.id, name: products.name })
    .from(products)
    .where(and(eq(products.status, "active"), isNull(products.deletedAt), isNull(products.postCardPath)));
  if (rows.length === 0) {
    console.log("Nenhuma peça ativa sem cartão: nada a fazer.");
    return;
  }
  const queued = await enqueueProductCardRefresh(db, {
    productIds: rows.map((row) => row.id),
    reason: "backfill",
  });
  console.log(`${queued} evento(s) de product.card_refresh enfileirado(s) para: ${rows.map((row) => row.name).join(", ")}.`);
  console.log("A fila desenha um por vez (20 s entre eles); a prévia do link troca sozinha.");
}

main().catch((error) => {
  console.error("Falha no backfill:", error);
  process.exit(1);
});
