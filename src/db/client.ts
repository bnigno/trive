import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

let db: Db | undefined;

/**
 * Driver do app: node-postgres (pg), NUNCA postgres.js.
 * Motivo (bug reproduzido em produção): o postgres.js "empilha" consultas
 * paralelas numa mesma conexão (pipelining) e o Supavisor do Supabase em
 * transaction mode congela a conexão para sempre nesse cenário — o admin
 * inteiro travava. Desligar o pipelining (max_pipeline: 0) quebra as
 * transações do Drizzle. O pg envia uma consulta por vez por conexão e é o
 * driver canônico com poolers; também serializa Date em parâmetros.
 * (postgres.js segue em uso apenas nos scripts sequenciais: migrate/seed.)
 */
export function getDb(): Db {
  if (!db) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "DATABASE_URL ausente. Defina a variável de ambiente antes de acessar o banco.",
      );
    }
    const pool = new Pool({
      connectionString: url,
      max: 5,
      idleTimeoutMillis: 20_000,
      connectionTimeoutMillis: 15_000,
    });
    db = drizzle(pool, { schema });
  }
  return db;
}
