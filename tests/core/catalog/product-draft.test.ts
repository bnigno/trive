// Rascunho da ficha pela foto (PURO): prompt estável, JSON Schema sem $ref,
// normalização honesta (categoria por slug, cores/tamanhos no padrão da
// grade, avisos em vez de invenção).
import { describe, expect, it } from "vitest";

import {
  buildProductDraftPrompt,
  DRAFT_MAX_COLORS,
  normalizeProductDraft,
  PRODUCT_DRAFT_JSON_SCHEMA,
  rawProductDraftSchema,
  type RawProductDraft,
} from "@/core/catalog/product-draft";

const CATEGORIES = [
  { id: "c-vestidos", name: "Vestidos", slug: "vestidos" },
  { id: "c-blusas", name: "Blusas", slug: "blusas" },
];

const LONG = "Vestido longo de linho com caimento fluido, alças finas e saia evasê. ".repeat(6);

function raw(over: Partial<RawProductDraft> = {}): RawProductDraft {
  return {
    name: "Vestido Áurea",
    categorySlug: "vestidos",
    colors: ["areia", "TERRACOTA", "areia "],
    sizes: ["p", "M", "g"],
    description: LONG,
    composition: "100% linho",
    careSymbols: ["hand_wash", "dry_shade", "hand_wash", "lavar com carinho"],
    careFreeText: "Não torcer\n",
    fitNotes: " Corte fluido ",
    weightGramsEstimate: 320.4,
    warnings: [" Etiqueta parcialmente ilegível ", ""],
    ...over,
  };
}

describe("buildProductDraftPrompt", () => {
  it("é determinístico e cita manifesto, salas com slug, cores/tamanhos conhecidos e as chaves de cuidado", () => {
    const input = {
      storeName: "TRIVÉ",
      manifesto: "Curadoria para o calor de Belém.",
      categories: CATEGORIES,
      knownColors: ["Areia", "Preto"],
      knownSizes: ["P", "M"],
    };
    const a = buildProductDraftPrompt(input);
    expect(buildProductDraftPrompt(input)).toBe(a);
    expect(a).toContain("Curadoria para o calor de Belém.");
    expect(a).toContain("- Vestidos (slug: vestidos)");
    expect(a).toContain("Areia, Preto");
    expect(a).toContain("hand_wash = Lavar à mão");
    expect(a).toContain("pelo menos 300 caracteres");
    expect(a).toContain("nunca chute uma grade");
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("sem manifesto e sem salas: tom padrão e categorySlug null", () => {
    const prompt = buildProductDraftPrompt({ storeName: "TRIVÉ", manifesto: "  ", categories: [], knownColors: [], knownSizes: [] });
    expect(prompt).toContain("TOM DA MAISON: elegante");
    expect(prompt).toContain("nenhuma sala cadastrada");
  });
});

describe("PRODUCT_DRAFT_JSON_SCHEMA", () => {
  it("é um objeto fechado, sem $ref, com as mesmas chaves do schema Zod", () => {
    const json = JSON.stringify(PRODUCT_DRAFT_JSON_SCHEMA);
    expect(json).not.toContain("$ref");
    expect(PRODUCT_DRAFT_JSON_SCHEMA.additionalProperties).toBe(false);
    const keys = Object.keys(PRODUCT_DRAFT_JSON_SCHEMA.properties as Record<string, unknown>).sort();
    expect(keys).toEqual(Object.keys(rawProductDraftSchema.shape).sort());
    expect(PRODUCT_DRAFT_JSON_SCHEMA.required).toEqual(expect.arrayContaining(keys));
  });
});

describe("normalizeProductDraft", () => {
  it("resolve a sala pelo slug, normaliza cores/tamanhos sem repetir, separa pictogramas de texto e arredonda o peso", () => {
    const draft = normalizeProductDraft(raw(), { categories: CATEGORIES });
    expect(draft.categoryId).toBe("c-vestidos");
    expect(draft.categoryName).toBe("Vestidos");
    expect(draft.colors).toEqual(["Areia", "Terracota"]);
    expect(draft.sizes).toEqual(["P", "M", "G"]);
    expect(draft.careSymbols).toEqual(["hand_wash", "dry_shade"]);
    expect(draft.careFreeText).toEqual(["Não torcer", "lavar com carinho"]);
    expect(draft.fitNotes).toBe("Corte fluido");
    expect(draft.weightGrams).toBe(320);
    expect(draft.warnings).toEqual(["Etiqueta parcialmente ilegível"]);
  });

  it("slug desconhecido vira null com aviso; descrição curta, peso fora da faixa e sem peso viram avisos", () => {
    const draft = normalizeProductDraft(
      raw({ categorySlug: "casa", description: "Curta.", weightGramsEstimate: 9000, warnings: [] }),
      { categories: CATEGORIES },
    );
    expect(draft.categoryId).toBeNull();
    expect(draft.warnings).toEqual([
      'A sala sugerida ("casa") não existe: escolha uma da lista.',
      "Descrição curta (6 caracteres; a peça fica pronta com 200).",
      "Peso estimado fora da faixa (9000 g): confira na balança.",
    ]);
    const semPeso = normalizeProductDraft(raw({ weightGramsEstimate: null, warnings: [] }), { categories: CATEGORIES });
    expect(semPeso.weightGrams).toBeNull();
    expect(semPeso.warnings).toEqual(["Sem estimativa de peso: cadastre o peso para o frete não usar 300 g."]);
  });

  it("respeita os tetos de cores, corta o nome em 80 e avisa quando não há nome", () => {
    const cores = Array.from({ length: 10 }, (_, i) => `Cor ${i}`);
    const draft = normalizeProductDraft(raw({ colors: cores, name: "x".repeat(100) }), { categories: CATEGORIES });
    expect(draft.colors).toHaveLength(DRAFT_MAX_COLORS);
    expect(draft.name).toHaveLength(80);
    expect(normalizeProductDraft(raw({ name: "  " }), { categories: CATEGORIES }).warnings).toContain(
      "O modelo não sugeriu nome: escreva um.",
    );
  });

  it("JSON fora do formato lança", () => {
    expect(() => normalizeProductDraft({ name: 1 }, { categories: CATEGORIES })).toThrow();
    expect(() => normalizeProductDraft("nada", { categories: CATEGORIES })).toThrow();
  });
});
