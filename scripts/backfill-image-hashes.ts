// Calcula a impressão digital (dHash, coluna product_images.phash) das fotos
// de produto que ainda não têm — as enviadas antes da Lia reconhecer peças
// pela foto. Lê cada -full.webp do Storage (o mesmo arquivo que o upload
// hasheia) e grava o hex. Idempotente: pula quem já tem; --force recalcula
// todas; --relatorio imprime o par de PRODUTOS PÚBLICOS DIFERENTES com as
// fotos mais parecidas (para calibrar o limiar em core/bot/photo-match.ts).
// Uso (produção):
//   ADAPTER_MODE=real npx tsx --env-file=.env.prod.local scripts/backfill-image-hashes.ts --relatorio
import { and, eq, isNotNull, isNull } from "drizzle-orm";

import { getFileStorage } from "@/adapters/storage";
import { hammingDistance, hexToPhash } from "@/core/images/phash";
import { getDb } from "@/db/client";
import { productImages, products } from "@/db/schema";
import { imagePhash } from "@/services/image-fingerprint";

const force = process.argv.includes("--force");
const report = process.argv.includes("--relatorio");

async function main(): Promise<void> {
  const db = getDb();
  const storage = getFileStorage();
  const rows = await db
    .select({ id: productImages.id, path: productImages.storagePath, phash: productImages.phash })
    .from(productImages)
    .where(force ? undefined : isNull(productImages.phash));

  let computed = 0;
  let skipped = 0;
  let missing = 0;
  for (const row of rows) {
    if (!row.path.endsWith("-full.webp")) {
      console.warn(`pulando ${row.path}: não é a rendição -full.webp`);
      skipped++;
      continue;
    }
    let file: { data: Buffer };
    try {
      file = await storage.download(row.path);
    } catch (error) {
      console.warn(`sem arquivo no Storage: ${row.path} (${error instanceof Error ? error.message : error})`);
      missing++;
      continue;
    }
    const phash = await imagePhash(file.data);
    if (!phash) {
      console.warn(`imagem que o sharp não abre: ${row.path}`);
      missing++;
      continue;
    }
    await db.update(productImages).set({ phash }).where(eq(productImages.id, row.id));
    computed++;
    console.log(`hash ${phash}: ${row.path}`);
  }
  console.log(`concluído: ${computed} calculada(s), ${skipped} pulada(s), ${missing} sem arquivo, ${rows.length} foto(s) lidas.`);

  if (report) await printClosestPairs(db);
}

/** O par mais próximo entre fotos de produtos públicos DIFERENTES: o limiar tem de ficar bem abaixo dele. */
async function printClosestPairs(db: ReturnType<typeof getDb>): Promise<void> {
  const photos = await db
    .select({ phash: productImages.phash, slug: products.slug, color: productImages.color })
    .from(productImages)
    .innerJoin(products, eq(products.id, productImages.productId))
    .where(and(isNotNull(productImages.phash), eq(products.status, "active"), isNull(products.deletedAt)));
  const parsed = photos.flatMap((photo) => {
    const hash = photo.phash ? hexToPhash(photo.phash) : null;
    return hash === null ? [] : [{ hash, slug: photo.slug, color: photo.color }];
  });
  const pairs: { distance: number; a: string; b: string }[] = [];
  for (let i = 0; i < parsed.length; i += 1) {
    for (let j = i + 1; j < parsed.length; j += 1) {
      if (parsed[i].slug === parsed[j].slug) continue;
      pairs.push({ distance: hammingDistance(parsed[i].hash, parsed[j].hash), a: `${parsed[i].slug} (${parsed[i].color ?? "—"})`, b: `${parsed[j].slug} (${parsed[j].color ?? "—"})` });
    }
  }
  pairs.sort((x, y) => x.distance - y.distance);
  console.log(`relatório: ${parsed.length} foto(s) de produtos públicos; pares de produtos diferentes mais parecidos:`);
  for (const pair of pairs.slice(0, 5)) console.log(`  ${String(pair.distance).padStart(2)} bits  ${pair.a}  ×  ${pair.b}`);
  if (pairs.length > 0 && pairs[0].distance <= 10) {
    console.warn("  ATENÇÃO: há produtos diferentes com fotos quase iguais dentro do limiar 'talvez' (10) — confira o catálogo (mesma foto em duas peças?).");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
