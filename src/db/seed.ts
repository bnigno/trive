import "dotenv/config";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { settings } from "./schema";

// JSON.stringify + cast garante jsonb 'null' (JSON null) em vez de NULL SQL,
// que violaria o NOT NULL da coluna value.
function toJsonb(value: unknown) {
  return sql`${JSON.stringify(value)}::jsonb`;
}

const initialSettings: Array<{ key: string; value: unknown }> = [
  { key: "approval_price_change_pct", value: 0.1 },
  { key: "approval_below_min_margin", value: true },
  { key: "stock_reservation_ttl_minutes", value: 120 },
  { key: "owner_whatsapp_phone", value: null },
];

// Fase 1: seeds operacionais (categorias, formas de envio, templates de
// mensagem WhatsApp, margens mínimas por categoria) entram aqui, no mesmo
// padrão idempotente de upsert.

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      "Erro: DATABASE_URL não definida. Configure a variável no arquivo .env (veja .env.example) antes de rodar o seed.",
    );
    process.exit(1);
  }

  const client = postgres(url, { prepare: false, max: 1 });
  const db = drizzle(client);
  try {
    for (const { key, value } of initialSettings) {
      await db
        .insert(settings)
        .values({ key, value: toJsonb(value) })
        .onConflictDoNothing({ target: settings.key });
    }
    console.log("Seed concluído: settings iniciais garantidas.");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("Falha ao rodar o seed:", error);
  process.exit(1);
});
