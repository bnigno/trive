// Garante o bucket público 'product-images' no Supabase Storage.
// Uso: npx tsx --env-file=<arquivo-env> scripts/setup-storage.ts
import { createClient } from "@supabase/supabase-js";

import { CURATOR_AUDIO_CANONICAL_MIMES } from "@/core/catalog/curator-note";

const BUCKET = "product-images";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceKey) {
  console.error(
    "Variáveis NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórias.",
  );
  console.error("Uso: npx tsx --env-file=<arquivo-env> scripts/setup-storage.ts");
  process.exit(1);
}

async function main() {
  const client = createClient(supabaseUrl!, serviceKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: buckets, error: listError } = await client.storage.listBuckets();
  if (listError) {
    console.error(`Falha ao listar buckets: ${listError.message}`);
    process.exit(1);
  }

  // A mesma lista nos dois ramos (criar e atualizar): o Supabase compara o
  // mime por igualdade, então os áudios entram já canônicos (core decide).
  const IMAGE_MIMES = ["image/webp", "image/png", "image/jpeg", "image/avif"];
  const bucketConfig = {
    public: true,
    fileSizeLimit: "10MB",
    allowedMimeTypes: [...IMAGE_MIMES, ...CURATOR_AUDIO_CANONICAL_MIMES],
  };

  if (buckets?.some((bucket) => bucket.name === BUCKET)) {
    // A nota da curadora é áudio no mesmo bucket: atualizar é seguro e
    // idempotente (o script roda de novo a cada mudança de formato aceito).
    const { error: updateError } = await client.storage.updateBucket(BUCKET, bucketConfig);
    if (updateError) {
      console.error(`Falha ao atualizar bucket '${BUCKET}': ${updateError.message}`);
      process.exit(1);
    }
    console.log(`Bucket '${BUCKET}' atualizado: imagens e áudio da nota da curadora.`);
    return;
  }

  const { error: createError } = await client.storage.createBucket(BUCKET, bucketConfig);
  if (createError) {
    console.error(`Falha ao criar bucket '${BUCKET}': ${createError.message}`);
    process.exit(1);
  }

  console.log(`Bucket público '${BUCKET}' criado com sucesso.`);
}

void main();
