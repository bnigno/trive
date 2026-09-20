// "Pronta para abrir": a regra que decide o selo de cada peça e o termômetro.
import { describe, expect, it } from "vitest";

import {
  assessLiaReadiness,
  assessProductReadiness,
  DESCRIPTION_MIN_CHARS,
  type ReadinessFacts,
  type ReadinessVariantFacts,
  summarizeLiaReadiness,
  summarizeReadiness,
} from "@/core/catalog/readiness";

const variant = (over: Partial<ReadinessVariantFacts> = {}): ReadinessVariantFacts => ({
  isActive: true,
  weightGrams: 300,
  hasActivePrice: true,
  hasPendingPrice: false,
  available: 3,
  ...over,
});

const completa: ReadinessFacts = {
  status: "active",
  descriptionLength: DESCRIPTION_MIN_CHARS,
  photoCount: 2,
  categoryId: "cat-1",
  categoryHasCover: true,
  variants: [variant()],
  // Ficha completa para a Lia (tipo, composição, como veste, nota): não muda a prontidão de venda.
  pieceType: "vestido",
  compositionLength: 20,
  fitNotesLength: 40,
  curatorNoteLength: 60,
};

const codes = (facts: ReadinessFacts) =>
  assessProductReadiness(facts).issues.map((issue) => issue.code);

describe("assessProductReadiness", () => {
  it("peça completa está pronta, sem pendências", () => {
    expect(assessProductReadiness(completa)).toEqual({
      level: "ready",
      issues: [],
      primaryIssue: null,
      lia: [],
    });
  });

  it("rascunho completo bloqueia e aponta para o status", () => {
    const result = assessProductReadiness({ ...completa, status: "draft" });
    expect(result.level).toBe("blocked");
    expect(result.primaryIssue).toMatchObject({ code: "draft", anchor: "status" });
  });

  it("arquivada tem nível próprio e não conta como bloqueio de venda", () => {
    const result = assessProductReadiness({ ...completa, status: "archived" });
    expect(result.level).toBe("archived");
    expect(result.issues.map((issue) => issue.code)).toEqual(["archived"]);
  });

  it("fotos: nenhuma bloqueia, uma só avisa", () => {
    expect(assessProductReadiness({ ...completa, photoCount: 0 })).toMatchObject({
      level: "blocked",
      primaryIssue: { code: "no_photo", anchor: "imagens" },
    });
    expect(assessProductReadiness({ ...completa, photoCount: 1 })).toMatchObject({
      level: "almost",
      primaryIssue: { code: "one_photo" },
    });
  });

  it("descrição: 199 caracteres é curta, 200 passa, vazia é 'sem descrição' com foco no campo", () => {
    expect(codes({ ...completa, descriptionLength: DESCRIPTION_MIN_CHARS - 1 })).toEqual([
      "short_description",
    ]);
    expect(codes({ ...completa, descriptionLength: DESCRIPTION_MIN_CHARS })).toEqual([]);
    const semDescricao = assessProductReadiness({ ...completa, descriptionLength: 0 });
    expect(semDescricao.primaryIssue).toMatchObject({
      code: "no_description",
      focus: "description",
      anchor: "dados-basicos",
    });
  });

  it("preço: pendente de aprovação diz isso; sem versão nenhuma diz 'sem preço'", () => {
    expect(
      assessProductReadiness({
        ...completa,
        variants: [variant({ hasActivePrice: false, hasPendingPrice: true })],
      }).primaryIssue?.code,
    ).toBe("price_pending");
    expect(
      assessProductReadiness({
        ...completa,
        variants: [variant({ hasActivePrice: false })],
      }).primaryIssue?.code,
    ).toBe("no_price");
  });

  it("peso ausente numa variação ATIVA é aviso (frete usa 300 g); em variação inativa não conta", () => {
    expect(
      assessProductReadiness({
        ...completa,
        variants: [variant(), variant({ weightGrams: null })],
      }),
    ).toMatchObject({
      level: "almost",
      primaryIssue: { code: "no_weight", focus: "weightGrams", anchor: "variacoes" },
    });
    expect(
      codes({ ...completa, variants: [variant(), variant({ isActive: false, weightGrams: null })] }),
    ).toEqual([]);
  });

  it("estoque zero (somando só as ativas) bloqueia; sem variação ativa também", () => {
    expect(
      codes({ ...completa, variants: [variant({ available: 0 }), variant({ isActive: false, available: 9 })] }),
    ).toEqual(["no_stock"]);
    expect(codes({ ...completa, variants: [variant({ isActive: false })] })).toEqual([
      "no_active_variant",
    ]);
    expect(codes({ ...completa, variants: [] })).toEqual(["no_active_variant"]);
  });

  it("sala: sem sala avisa; com sala sem capa avisa apontando para as salas", () => {
    expect(codes({ ...completa, categoryId: null, categoryHasCover: false })).toEqual([
      "no_category",
    ]);
    expect(assessProductReadiness({ ...completa, categoryHasCover: false }).primaryIssue).toMatchObject(
      { code: "category_no_cover", anchor: "categorias" },
    );
  });

  it("bloqueios vêm antes dos avisos e o primeiro vira o selo", () => {
    const result = assessProductReadiness({
      ...completa,
      status: "draft",
      photoCount: 1,
      descriptionLength: 10,
      variants: [variant({ hasActivePrice: false, weightGrams: null })],
    });
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "draft",
      "no_price",
      "one_photo",
      "short_description",
      "no_weight",
    ]);
    expect(result.primaryIssue?.code).toBe("draft");
    expect(result.level).toBe("blocked");
  });
});

describe("summarizeReadiness", () => {
  it("conta prontas sobre o total sem as arquivadas; lista vazia nunca é 'tudo pronto'", () => {
    expect(
      summarizeReadiness([
        { level: "ready" },
        { level: "almost" },
        { level: "blocked" },
        { level: "archived" },
      ]),
    ).toEqual({ ready: 1, total: 3, allReady: false });
    expect(summarizeReadiness([{ level: "ready" }, { level: "archived" }])).toEqual({
      ready: 1,
      total: 1,
      allReady: true,
    });
    expect(summarizeReadiness([])).toEqual({ ready: 0, total: 0, allReady: false });
  });
});

describe("o que falta para a Lia falar bem (assessLiaReadiness)", () => {
  const pronta = {
    status: "active",
    descriptionLength: 300,
    photoCount: 2,
    categoryId: "c1",
    categoryHasCover: true,
    variants: [{ isActive: true, weightGrams: 300, hasActivePrice: true, hasPendingPrice: false, available: 3 }],
  };

  it("peça pronta para vender com a ficha vazia: continua 'ready', mas os 4 campos da Lia faltam, na ordem em que a dona resolveria", () => {
    const readiness = assessProductReadiness(pronta);
    expect(readiness.level).toBe("ready");
    expect(readiness.primaryIssue).toBeNull();
    expect(readiness.lia.map((issue) => issue.code)).toEqual(["no_piece_type", "no_composition", "no_fit_notes", "no_curator_note"]);
    expect(readiness.lia[0]).toMatchObject({ anchor: "dados-basicos", focus: "pieceType" });
    expect(readiness.lia[3]).toMatchObject({ anchor: "nota-da-curadora" });
  });

  it("ficha completa → nada falta; arquivada → nada (não é caso para a Lia)", () => {
    expect(assessLiaReadiness({ ...pronta, pieceType: "vestido", compositionLength: 20, fitNotesLength: 40, curatorNoteLength: 60 })).toEqual([]);
    expect(assessLiaReadiness({ ...pronta, status: "archived" })).toEqual([]);
    expect(assessProductReadiness({ ...pronta, status: "archived" }).lia).toEqual([]);
  });

  it("o resumo conta peças não arquivadas com ficha completa e as faltas por campo", () => {
    const completa = assessProductReadiness({ ...pronta, pieceType: "vestido", compositionLength: 20, fitNotesLength: 40, curatorNoteLength: 60 });
    const soTipo = assessProductReadiness({ ...pronta, pieceType: "corset" });
    const arquivada = assessProductReadiness({ ...pronta, status: "archived" });
    expect(summarizeLiaReadiness([completa, soTipo, arquivada])).toEqual({
      total: 2,
      complete: 1,
      byCode: { no_piece_type: 0, no_composition: 1, no_fit_notes: 1, no_curator_note: 1 },
    });
  });
});
