// Gera a rendição média (-md.webp, 800w) das fotos de produto enviadas antes
// dela existir. Lê cada -full.webp pela URL pública do bucket, redimensiona com
// o mesmo renderWebp do upload e sobe ao lado. Idempotente: pula quem já tem.
// Uso (env no shell, como os demais scripts):
//   DATABASE_URL=... NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   ADAPTER_MODE=real npx tsx scripts/backfill-image-md.ts
import { getFileStorage } from "@/adapters/storage";
import { getDb } from "@/db/client";
import { productImages } from "@/db/schema";
import { IMAGE_RENDITIONS, mdPathFor, renderWebp } from "@/services/catalog";
import { publicImageUrl, publicMdUrl } from "@/services/store-catalog";

async function exists(url: string): Promise<boolean> {
  const res = await fetch(url, { method: "HEAD" });
  return res.ok;
}

async function main() {
  const db = getDb();
  const storage = getFileStorage();
  const rows = await db
    .select({ id: productImages.id, path: productImages.storagePath })
    .from(productImages);

  let created = 0;
  let skipped = 0;
  for (const row of rows) {
    if (!row.path.endsWith("-full.webp")) {
      skipped++;
      continue;
    }
    if (await exists(publicMdUrl(row.path))) {
      skipped++;
      continue;
    }
    const res = await fetch(publicImageUrl(row.path));
    if (!res.ok) {
      console.warn(`pulando ${row.path}: original respondeu ${res.status}`);
      skipped++;
      continue;
    }
    const source = Buffer.from(await res.arrayBuffer());
    const md = await renderWebp(source, IMAGE_RENDITIONS.md);
    await storage.upload({
      path: mdPathFor(row.path),
      data: md,
      contentType: "image/webp",
    });
    created++;
    console.log(`gerado: ${mdPathFor(row.path)}`);
  }
  console.log(
    `concluído: ${created} gerada(s), ${skipped} pulada(s), ${rows.length} foto(s).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
