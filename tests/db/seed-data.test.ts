// O seed-data é puro e coerente: chaves únicas, template drop_open presente
// com as variáveis que o aviso preenche, e cada template declara as variáveis
// que o corpo usa.
import { describe, expect, it } from "vitest";

import { initialSettings, initialWaTemplates } from "@/db/seed-data";

describe("seed-data", () => {
  it("chaves únicas em settings e templates", () => {
    const settingKeys = initialSettings.map((s) => s.key);
    expect(new Set(settingKeys).size).toBe(settingKeys.length);
    const templateKeys = initialWaTemplates.map((t) => t.key);
    expect(new Set(templateKeys).size).toBe(templateKeys.length);
  });

  it("todo template declara as variáveis que usa no corpo", () => {
    for (const template of initialWaTemplates) {
      const used = [...template.bodyTemplate.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]);
      for (const variable of used) expect(template.variables, `${template.key} usa {{${variable}}}`).toContain(variable);
    }
  });

  it("drop_open existe com nome, lançamento, peças e link, e pede SAIR", () => {
    const template = initialWaTemplates.find((t) => t.key === "drop_open")!;
    expect(template).toBeDefined();
    expect(template.variables).toEqual(["nome", "lancamento", "pecas", "link"]);
    expect(template.bodyTemplate).toContain("SAIR");
  });
});
