// Rascunho da ficha pela foto (PURO): prompt estável, JSON Schema sem $ref,
// normalização honesta (categoria por slug, cores/tamanhos no padrão da
// grade, avisos em vez de invenção).
import { describe, expect, it } from "vitest";

import {
  buildProductDraftPrompt,
  DRAFT_MAX_COLORS,
  DRAFT_MAX_SIZES,
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
    measurementsBySize: [
      { size: "P", bust: 88, waist: 70 },
      { size: "M", bust: 92 },
    ],
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

  it("respeita os tetos de cores e tamanhos (avisando o corte), corta o nome em 80 e avisa quando não há nome", () => {
    const cores = Array.from({ length: 10 }, (_, i) => `Cor ${i}`);
    const tamanhos = Array.from({ length: 11 }, (_, i) => `T${i}`);
    const draft = normalizeProductDraft(
      raw({ colors: cores, sizes: tamanhos, name: "x".repeat(100), warnings: [] }),
      { categories: CATEGORIES },
    );
    expect(draft.colors).toHaveLength(DRAFT_MAX_COLORS);
    expect(draft.sizes).toHaveLength(DRAFT_MAX_SIZES);
    expect(draft.colors).toEqual(cores.slice(0, DRAFT_MAX_COLORS));
    expect(draft.sizes).toEqual(tamanhos.slice(0, DRAFT_MAX_SIZES));
    expect(draft.warnings).toContain(
      `O modelo leu 10 cores; mantive as ${DRAFT_MAX_COLORS} primeiras — confira as fichas de cor.`,
    );
    expect(draft.warnings).toContain(
      `O modelo leu 11 tamanhos; mantive os ${DRAFT_MAX_SIZES} primeiros — confira as fichas de tamanho.`,
    );
    // Dentro do teto, nenhum aviso de corte.
    expect(
      normalizeProductDraft(raw({ warnings: [] }), { categories: CATEGORIES }).warnings.some((w) =>
        w.includes("mantive as"),
      ),
    ).toBe(false);
    expect(draft.name).toHaveLength(80);
    expect(normalizeProductDraft(raw({ name: "  " }), { categories: CATEGORIES }).warnings).toContain(
      "O modelo não sugeriu nome: escreva um.",
    );
  });

  it("corta textos longos e avisa quando a etiqueta traz recado de terceiro", () => {
    const draft = normalizeProductDraft(
      raw({
        description: "d".repeat(2000),
        composition: "c".repeat(500),
        fitNotes: "Fale no (91) 98888-7777 para pedidos",
        careFreeText: "Compre direto: www.fornecedor.com",
        warnings: [],
      }),
      { categories: CATEGORIES },
    );
    expect(draft.description).toHaveLength(1200);
    expect(draft.composition).toHaveLength(200);
    const aviso = draft.warnings.find((warning) => warning.includes("recado do fornecedor"));
    expect(aviso).toBeDefined();
    expect(aviso).toContain("telefone");
    expect(aviso).toContain("link");
    expect(aviso).toContain("vai para a loja e para a vendedora");
    // Texto limpo não vira aviso.
    expect(
      normalizeProductDraft(raw({ warnings: [] }), { categories: CATEGORIES }).warnings.some((w) =>
        w.includes("recado do fornecedor"),
      ),
    ).toBe(false);
  });

  it("casa a tabela de medidas com as fichas de tamanho, em cm", () => {
    const draft = normalizeProductDraft(raw(), { categories: CATEGORIES });
    expect(draft.measurementsBySize).toEqual({
      P: { bust: 88, waist: 70 },
      M: { bust: 92 },
    });
    // Só os tamanhos da grade: a tabela citar GG não cria medida órfã.
    const comGG = normalizeProductDraft(
      raw({
        measurementsBySize: [
          { size: "P", bust: 88 },
          { size: "GG", bust: 104 },
        ],
        warnings: [],
      }),
      { categories: CATEGORIES },
    );
    expect(Object.keys(comGG.measurementsBySize)).toEqual(["P"]);
    expect(comGG.warnings).toContain(
      "A tabela de medidas cita GG, que não está nas fichas de tamanho: acrescente a ficha ou deixe essas medidas de fora.",
    );
  });

  it("sem tabela nas fotos (null) ou com medida impossível: nenhuma medida entra", () => {
    expect(
      normalizeProductDraft(raw({ measurementsBySize: null }), { categories: CATEGORIES })
        .measurementsBySize,
    ).toEqual({});
    // 0 cm e 900 cm não passam pelo schema de medidas (1–300).
    expect(
      normalizeProductDraft(
        raw({
          measurementsBySize: [
            { size: "P", bust: 0 },
            { size: "M", waist: 900 },
          ],
        }),
        { categories: CATEGORIES },
      ).measurementsBySize,
    ).toEqual({});
  });

  it("tabela em polegadas convertida entra arredondada no meio centímetro", () => {
    // 35 in = 88,9 cm; 27,5 in = 69,85 cm — o que o prompt manda converter.
    const draft = normalizeProductDraft(
      raw({
        sizes: ["P"],
        measurementsBySize: [{ size: "P", bust: 88.9, waist: 69.85, hip: 94 }],
        warnings: [],
      }),
      { categories: CATEGORIES },
    );
    expect(draft.measurementsBySize).toEqual({ P: { bust: 89, waist: 70, hip: 94 } });
    expect(draft.warnings.some((warning) => warning.includes("Não entendi estas medidas"))).toBe(false);
  });

  it("uma medida torta não leva junto as outras do mesmo tamanho, e a dona é avisada", () => {
    const draft = normalizeProductDraft(
      raw({
        sizes: ["P"],
        measurementsBySize: [{ size: "P", bust: 88, waist: 900, hip: 94 }],
        warnings: [],
      }),
      { categories: CATEGORIES },
    );
    expect(draft.measurementsBySize).toEqual({ P: { bust: 88, hip: 94 } });
    expect(draft.warnings.some((warning) => warning.includes("Cintura do P (900)"))).toBe(true);
  });

  it("o prompt manda transcrever a tabela em centímetros e nunca estimar", () => {
    const prompt = buildProductDraftPrompt({
      storeName: "TRIVÉ",
      manifesto: "",
      categories: CATEGORIES,
      knownColors: [],
      knownSizes: [],
    });
    expect(prompt).toContain("measurementsBySize");
    expect(prompt).toContain("PEÇA DEITADA");
    expect(prompt).toContain("1 in = 2,54 cm");
    expect(prompt).toContain("nunca estime medidas");
  });

  it("JSON fora do formato lança", () => {
    expect(() => normalizeProductDraft({ name: 1 }, { categories: CATEGORIES })).toThrow();
    expect(() => normalizeProductDraft("nada", { categories: CATEGORIES })).toThrow();
  });
});
