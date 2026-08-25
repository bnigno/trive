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
    // prepare: false — obrigatório com pooler Supabase em transaction mode.
    // max: 5 (NUNCA 1): com max: 1, consultas paralelas (Promise.all) são
    // "pipelined" numa única conexão, e o Supavisor trava a conexão para
    // sempre quando isso acontece após uma consulta anterior concluída —
    // bug reproduzido em produção (páginas do admin congelavam). Com pool > 1,
    // consultas concorrentes usam conexões separadas e o problema some.
    // max_pipeline: 0 é a parte ESSENCIAL: proíbe enviar uma consulta numa
    // conexão que ainda espera resposta de outra (pipelining) — o Supavisor
    // congela a conexão nesse cenário.
    const client = postgres(url, {
      prepare: false,
      max: 5,
      // @ts-expect-error -- max_pipeline é aceito em runtime (lista `ints` em
      // postgres/src/index.js) mas não está declarado nos types do driver.
      max_pipeline: 0,
      idle_timeout: 20,
      connect_timeout: 15,
    });
    db = drizzle(client, { schema });
  }
  return db;
}
