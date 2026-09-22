// Pede pela fila as fotos-base das modelos da casa que ainda não têm uma
// escolhida — 3 modelos × 4 cenas (× os corpos pedidos), 2 candidatas por
// combinação em qualidade alta (3 créditos cada; ≈ R$ 3,30 por combinação).
// Simula por padrão; --apply enfileira. Idempotente: combinação com foto
// escolhida (ou já na fila) é pulada. A geração acontece na fila (Inngest),
// não aqui — o script só cria os eventos.
// Uso: DOTENV_CONFIG_PATH=.env.prod.local npx tsx -r dotenv/config scripts/enfileirar-fotos-base.ts [--apply] [--tamanhos M,G] [--modelos modelo_a] [--cenas sala_clara]
import { eq } from "drizzle-orm";

import { creditsFor, creditsToUsdCents, usdCentsToBrlCents } from "@/core/studio/cost";
import { BODY_SIZE_KEYS, HOUSE_MODEL_KEYS, SCENE_KEYS } from "@/core/studio/presets";
import { getDb } from "@/db/client";
import { users } from "@/db/schema";
import { formatCentsBRL } from "@/lib/money";
import { enqueueStudioBasePhotos, listPendingStudioBasePhotoJobs, listStudioBasePhotos, studioBaseKey } from "@/services/studio";

const CANDIDATES = 2;
const QUALITY = "alta" as const;

function listArg<T extends string>(name: string, all: readonly T[], fallback: readonly T[] = all): T[] {
  const index = process.argv.indexOf(name);
  if (index === -1) return [...fallback];
  const raw = (process.argv[index + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const known = new Set<string>(all);
  for (const item of raw) if (!known.has(item)) throw new Error(`${name}: valor desconhecido "${item}" (aceita ${all.join(", ")})`);
  return raw as T[];
}

async function main() {
  const apply = process.argv.includes("--apply");
  // Marco 1: só o corpo M; os outros entram com "veja no seu tamanho".
  const sizes = listArg("--tamanhos", BODY_SIZE_KEYS, ["M"]);
  const models = listArg("--modelos", HOUSE_MODEL_KEYS);
  const scenes = listArg("--cenas", SCENE_KEYS);
  const db = getDb();
  const [owner] = await db.select({ id: users.id }).from(users).where(eq(users.role, "owner")).limit(1);
  const existing = await listStudioBasePhotos(db);
  const chosen = new Set(existing.filter((photo) => photo.status === "chosen").map((photo) => studioBaseKey(photo)));
  const pending = await listPendingStudioBasePhotoJobs(db);
  const perCombo = creditsToUsdCents(creditsFor("model_photo", QUALITY, CANDIDATES));

  let queued = 0;
  for (const sizeKey of sizes) for (const modelKey of models) for (const sceneKey of scenes) {
    const key = studioBaseKey({ modelKey, sceneKey, sizeKey });
    const state = chosen.has(key) ? "já escolhida" : pending.has(key) ? "já na fila" : apply ? "ENFILEIRADA" : "seria enfileirada";
    console.log(`${key.padEnd(34)} ${state}`);
    if (state !== "ENFILEIRADA") continue;
    await enqueueStudioBasePhotos(db, { modelKey, sceneKey, sizeKey, quality: QUALITY, count: CANDIDATES, userId: owner?.id ?? null }, new Date());
    queued += 1;
  }
  const combos = sizes.length * models.length * scenes.length;
  console.log(`\n${apply ? "Enfileiradas" : "Simulação"}: ${apply ? queued : combos} combinação(ões) × ${CANDIDATES} candidatas em ${QUALITY} ≈ ${formatCentsBRL(usdCentsToBrlCents(perCombo * (apply ? queued : combos)))} (R$ 5,50/US$).`);
  if (!apply) console.log("Nada foi enfileirado. Repita com --apply para valer.");
  process.exit(0);
}

main().catch((error) => {
  console.error("Falhou:", error instanceof Error ? error.message : error);
  process.exit(1);
});
