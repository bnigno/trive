// Liga (ou desliga) o vendedor IA no banco apontado por DATABASE_URL.
// Mesmo efeito do card "Vendedor com IA" no /admin/whatsapp — existe para a
// ativação assistida sem depender do navegador do dono.
// Uso: npx tsx --env-file=.env.prod.local scripts/enable-bot.ts [on|off]
import { sql } from "drizzle-orm";

import { getDb } from "@/db/client";

async function main() {
  const mode = process.argv[2] ?? "on";
  if (mode !== "on" && mode !== "off") {
    throw new Error("Uso: enable-bot.ts [on|off]");
  }
  const db = getDb();

  const upserts: Array<[string, string]> = [
    ["bot_enabled", mode === "on" ? "true" : "false"],
    ["bot_model", JSON.stringify("claude-sonnet-5")],
  ];
  for (const [key, value] of upserts) {
    await db.execute(
      sql`insert into settings (key, value) values (${key}, ${value}::jsonb)
          on conflict (key) do update set value = excluded.value, updated_at = now()`,
    );
  }

  const rows = await db.execute(
    sql`select key, value from settings
        where key in ('wa_enabled','bot_enabled','bot_model','owner_whatsapp_phone')
        order by key`,
  );
  console.table(rows.rows);
  console.log(
    mode === "on"
      ? "Robô LIGADO no banco. Lembre: em produção ele só responde se a ANTHROPIC_API_KEY estiver na hospedagem."
      : "Robô DESLIGADO no banco — o inbound volta a encaminhar tudo ao dono.",
  );
  process.exit(0);
}

main().catch((error) => {
  console.error("Falhou:", error);
  process.exit(1);
});
