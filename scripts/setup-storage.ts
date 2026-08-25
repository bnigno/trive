// Garante o bucket público 'product-images' no Supabase Storage.
// Uso: npx tsx --env-file=<arquivo-env> scripts/setup-storage.ts
import { createClient } from "@supabase/supabase-js";

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

  if (buckets?.some((bucket) => bucket.name === BUCKET)) {
    console.log(`Bucket '${BUCKET}' já existe; nada a fazer.`);
    return;
  }

  const { error: createError } = await client.storage.createBucket(BUCKET, {
    public: true,
    fileSizeLimit: "10MB",
    allowedMimeTypes: ["image/webp", "image/png", "image/jpeg", "image/avif"],
  });
  if (createError) {
    console.error(`Falha ao criar bucket '${BUCKET}': ${createError.message}`);
    process.exit(1);
  }

  console.log(`Bucket público '${BUCKET}' criado com sucesso.`);
}

void main();
