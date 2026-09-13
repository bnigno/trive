// Leva ao banco (dev ou produção) as chaves NOVAS do seed sem rodar o seed
// inteiro (que tem efeitos colaterais, como recriar a faixa de frete padrão).
// Insere settings e templates que faltam; só sobrescreve texto/variáveis de
// template existente com --force-templates (confira antes se a dona editou).
//
// Uso:
//   DOTENV_CONFIG_PATH=.env.prod.local npx tsx -r dotenv/config scripts/sync-seed.ts \
//     --settings chave_a,chave_b --templates drop_open [--force-templates]
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { settings, waTemplates } from "@/db/schema";
import { initialSettings, initialWaTemplates } from "@/db/seed-data";

function listArg(name: string): string[] {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) return [];
  return process.argv[index + 1].split(",").map((s) => s.trim()).filter(Boolean);
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL não definida.");
  const wantedSettings = listArg("--settings");
  const wantedTemplates = listArg("--templates");
  const force = process.argv.includes("--force-templates");
  if (wantedSettings.length === 0 && wantedTemplates.length === 0) {
    console.log("Nada a fazer: passe --settings a,b e/ou --templates c,d.");
    return;
  }

  const client = postgres(url, { prepare: false, max: 1, ssl: url.includes("supabase") ? "require" : undefined });
  const db = drizzle(client);
  try {
    for (const key of wantedSettings) {
      const item = initialSettings.find((s) => s.key === key);
      if (!item) throw new Error(`Setting "${key}" não existe no seed-data.`);
      const inserted = await db
        .insert(settings)
        .values({ key: item.key, value: sql`${JSON.stringify(item.value)}::jsonb` })
        .onConflictDoNothing({ target: settings.key })
        .returning({ key: settings.key });
      console.log(`setting ${key}: ${inserted.length ? "inserida" : "já existia (mantida)"}`);
    }
    for (const key of wantedTemplates) {
      const item = initialWaTemplates.find((t) => t.key === key);
      if (!item) throw new Error(`Template "${key}" não existe no seed-data.`);
      const inserted = await db
        .insert(waTemplates)
        .values({ key: item.key, label: item.label, bodyTemplate: item.bodyTemplate, variables: item.variables })
        .onConflictDoNothing({ target: waTemplates.key })
        .returning({ key: waTemplates.key });
      if (inserted.length) {
        console.log(`template ${key}: inserido`);
        continue;
      }
      if (!force) {
        console.log(`template ${key}: já existia (mantido; use --force-templates para atualizar corpo/variáveis)`);
        continue;
      }
      await db
        .update(waTemplates)
        .set({ label: item.label, bodyTemplate: item.bodyTemplate, variables: item.variables, updatedAt: sql`now()` })
        .where(sql`${waTemplates.key} = ${item.key}`);
      console.log(`template ${key}: corpo e variáveis atualizados (--force-templates)`);
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("Falha no sync-seed:", error);
  process.exit(1);
});
