// Sugere o tipo de peça (products.piece_type) pelo NOME de cada peça que
// ainda não tem tipo — "CORSET DOMINIQUE" → corset. Sem --apply só imprime a
// tabela para a dona conferir; com --apply grava onde há sugestão e lista as
// que ficaram sem (essas ela marca no painel, campo "Tipo de peça").
// Uso: npx tsx --env-file=.env.local scripts/sugerir-tipo-de-peca.ts [--apply]
import { and, eq, isNull } from "drizzle-orm";

import { pieceTypeLabel, suggestPieceType } from "@/core/catalog/piece-types";
import { getDb } from "@/db/client";
import { products } from "@/db/schema";

const apply = process.argv.includes("--apply");

async function main(): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ id: products.id, name: products.name, status: products.status })
    .from(products)
    .where(and(isNull(products.deletedAt), isNull(products.pieceType)))
    .orderBy(products.name);

  const semSugestao: string[] = [];
  let gravadas = 0;
  console.log(`${rows.length} peça(s) sem tipo${apply ? " — gravando as sugestões" : " — simulação (use --apply para gravar)"}`);
  for (const row of rows) {
    const suggestion = suggestPieceType(row.name);
    console.log(`${row.name.padEnd(40)}  ${row.status.padEnd(8)}  → ${suggestion ? `${suggestion} (${pieceTypeLabel(suggestion)})` : "(sem sugestão)"}`);
    if (!suggestion) {
      semSugestao.push(row.name);
      continue;
    }
    if (apply) {
      await db.update(products).set({ pieceType: suggestion }).where(eq(products.id, row.id));
      gravadas += 1;
    }
  }
  console.log(`\n${apply ? `${gravadas} gravada(s)` : `${rows.length - semSugestao.length} com sugestão`}; ${semSugestao.length} sem sugestão${semSugestao.length > 0 ? `: ${semSugestao.join(", ")}` : ""}.`);
  if (semSugestao.length > 0) console.log("As sem sugestão você marca no painel, em Produtos → peça → Tipo de peça.");
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
