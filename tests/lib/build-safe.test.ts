// A pré-renderização não pode derrubar o build por causa de banco fora do ar —
// mas também não pode esconder defeito nosso nem publicar loja vazia.
import { afterEach, describe, expect, it, vi } from "vitest";

import { isDatabaseUnreachable, tryOrBuildFallback } from "@/lib/build-safe";

afterEach(() => {
  vi.unstubAllEnvs();
});

const semConexao = () => {
  const erro = new Error("Failed query: select ...");
  (erro as { cause?: unknown }).cause = Object.assign(new Error("connect ECONNREFUSED"), {
    code: "ECONNREFUSED",
  });
  return erro;
};

/** O erro real de 10/2026: o projeto Supabase de DEV foi apagado. */
const projetoApagado = () => {
  const erro = new Error("Failed query: select 'key' from 'settings'");
  (erro as { cause?: unknown }).cause = new Error("(ENOTFOUND) tenant/user postgres.abc123 not found");
  return erro;
};

const sqlErrado = () => {
  const erro = new Error("Failed query");
  (erro as { cause?: unknown }).cause = Object.assign(new Error('column "nao_existe" does not exist'), {
    code: "42703",
  });
  return erro;
};

describe("isDatabaseUnreachable", () => {
  it("reconhece erro de conexão, inclusive na causa", () => {
    expect(isDatabaseUnreachable(semConexao())).toBe(true);
    expect(isDatabaseUnreachable(projetoApagado())).toBe(true);
  });

  it("pergunta errada NÃO é banco fora do ar", () => {
    expect(isDatabaseUnreachable(sqlErrado())).toBe(false);
    expect(isDatabaseUnreachable(new Error("qualquer coisa"))).toBe(false);
    expect(isDatabaseUnreachable(null)).toBe(false);
  });
});

describe("tryOrBuildFallback", () => {
  it("sem DATABASE_URL (CI), devolve o fallback", async () => {
    vi.stubEnv("DATABASE_URL", "");
    expect(await tryOrBuildFallback("vazio", async () => { throw semConexao(); })).toBe("vazio");
  });

  it("banco fora do ar em PREVIEW: a página sai vazia e o build segue", async () => {
    // O caso que travou todos os PRs: DATABASE_URL existe, o banco não.
    vi.stubEnv("DATABASE_URL", "postgres://morto/x");
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(await tryOrBuildFallback("vazio", async () => { throw projetoApagado(); })).toBe("vazio");
  });

  it("banco fora do ar em PRODUÇÃO: o erro SOBE — loja vazia calada é pior", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://morto/x");
    vi.stubEnv("VERCEL_ENV", "production");
    await expect(
      tryOrBuildFallback("vazio", async () => { throw projetoApagado(); }),
    ).rejects.toThrow(/Failed query/);
  });

  it("defeito nosso sobe em qualquer ambiente, nunca vira página vazia", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://vivo/x");
    vi.stubEnv("VERCEL_ENV", "preview");
    await expect(
      tryOrBuildFallback("vazio", async () => { throw sqlErrado(); }),
    ).rejects.toThrow(/Failed query/);
  });

  it("dando certo, devolve o valor de verdade", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://vivo/x");
    expect(await tryOrBuildFallback("vazio", async () => "o valor real")).toBe("o valor real");
  });
});
