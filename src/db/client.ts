import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;

let db: Db | undefined;

export function getDb(): Db {
  if (!db) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "DATABASE_URL ausente. Defina a variável de ambiente antes de acessar o banco.",
      );
    }
    // prepare: false + max: 1 — obrigatório com pooler Supabase em transaction mode.
    const client = postgres(url, { prepare: false, max: 1 });
    db = drizzle(client, { schema });
  }
  return db;
}
