// Sugere o tipo de peça (products.piece_type) pelo NOME de cada peça que
// ainda não tem tipo — "CORSET DOMINIQUE" → corset. Sem --apply só imprime a
// tabela para a dona conferir; com --apply grava onde há sugestão e lista as
// que ficaram sem (essas ela marca no painel, campo "Tipo de peça").
// No fim, lista também as peças JÁ marcadas cujo nome hoje sugere outro tipo
// (um sinônimo que mudou de dono, como "bermuda" saindo de short): essas
// nunca são regravadas aqui — a dona confere no painel.
// Uso: npx tsx --env-file=.env.local scripts/sugerir-tipo-de-peca.ts [--apply]
import { and, eq, isNotNull, isNull } from "drizzle-orm";

import { pieceTypeLabel, PIECE_TYPE_SLUGS, suggestPieceType, type PieceType } from "@/core/catalog/piece-types";
import { getDb } from "@/db/client";
import { products } from "@/db/schema";

const apply = process.argv.includes("--apply");

function labelOf(slug: string): string {
  return (PIECE_TYPE_SLUGS as readonly string[]).includes(slug) ? pieceTypeLabel(slug as PieceType) : slug;
}

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

  const marcadas = await db
    .select({ name: products.name, status: products.status, pieceType: products.pieceType })
    .from(products)
    .where(and(isNull(products.deletedAt), isNotNull(products.pieceType)))
    .orderBy(products.name);
  const divergentes = marcadas.flatMap((row) => {
    const suggestion = suggestPieceType(row.name);
    return suggestion && row.pieceType !== null && suggestion !== row.pieceType ? [{ ...row, pieceType: row.pieceType, suggestion }] : [];
  });
  if (divergentes.length > 0) {
    console.log(`\n${divergentes.length} peça(s) já marcada(s) cujo nome hoje sugere outro tipo (não regravo — confira no painel):`);
    for (const row of divergentes) {
      console.log(`${row.name.padEnd(40)}  ${row.status.padEnd(8)}  marcada ${labelOf(row.pieceType)} → nome sugere ${pieceTypeLabel(row.suggestion)}`);
    }
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
