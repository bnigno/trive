// A porta do banco fica fechada (migração 0058).
//
// Contexto: até 22/09/2026 as 62 tabelas de `public` estavam sem RLS e os
// papéis anon/authenticated tinham ALL — qualquer pessoa com a URL do projeto
// Supabase lia e apagava tudo pela API REST. O app não usa essa API, então a
// correção não custou nada; o risco real é ela voltar sem ninguém notar,
// porque o Supabase concede acesso a anon em TODA tabela nova por padrão
// (pg_default_acl).
//
// Por isso este teste: uma tabela criada numa migração futura sem RLS reabre
// o buraco em produção e aqui vira suíte vermelha.
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  await close();
});

describe("RLS nas tabelas de public", () => {
  it("toda tabela tem row level security ligado", async () => {
    const { rows } = await db.execute<{ tablename: string }>(sql`
      select tablename from pg_tables
      where schemaname = 'public' and not rowsecurity
      order by tablename
    `);

    const semRls = rows.map((row) => row.tablename);
    expect(
      semRls,
      semRls.length === 0
        ? ""
        : `Tabela(s) sem RLS: ${semRls.join(", ")}.\n` +
          "Toda tabela nova precisa de ALTER TABLE ... ENABLE ROW LEVEL SECURITY " +
          "na migração que a cria — veja drizzle/0058_rls_e_privilegios.sql. " +
          "Sem isso ela nasce legível e apagável por qualquer um pela API do Supabase.",
    ).toEqual([]);
  });

  it("existe tabela no banco de teste (o teste acima não passa por vazio)", async () => {
    const { rows } = await db.execute<{ total: number }>(
      sql`select count(*)::int as total from pg_tables where schemaname = 'public'`,
    );
    expect(rows[0]?.total ?? 0).toBeGreaterThan(50);
  });
});
