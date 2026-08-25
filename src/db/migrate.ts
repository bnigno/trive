import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      "Erro: DATABASE_URL não definida. Configure a variável no arquivo .env (veja .env.example) antes de rodar as migrações.",
    );
    process.exit(1);
  }

  const client = postgres(url, { prepare: false, max: 1 });
  try {
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
    console.log("Migrações aplicadas com sucesso.");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("Falha ao aplicar migrações:", error);
  process.exit(1);
});
