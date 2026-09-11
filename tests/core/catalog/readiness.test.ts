// "Pronta para abrir": a regra que decide o selo de cada peça e o termômetro.
import { describe, expect, it } from "vitest";

import {
  assessProductReadiness,
  DESCRIPTION_MIN_CHARS,
  summarizeReadiness,
  type ReadinessFacts,
  type ReadinessVariantFacts,
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
};

const codes = (facts: ReadinessFacts) =>
  assessProductReadiness(facts).issues.map((issue) => issue.code);

describe("assessProductReadiness", () => {
  it("peça completa está pronta, sem pendências", () => {
    expect(assessProductReadiness(completa)).toEqual({
      level: "ready",
      issues: [],
      primaryIssue: null,
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
