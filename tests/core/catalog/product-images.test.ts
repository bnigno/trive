// Quais fotos a galeria da vitrine mostra para a cor escolhida. Regra pura:
// a página do produto é RSC e o componente cliente só apresenta.
import { describe, expect, it } from "vitest";

import { findColorAxis, imagesForColor, isAiImage, orderImagesByPolicy, pickCoverImage } from "@/core/catalog/product-images";

type Photo = { id: string; color: string | null };

const verde1: Photo = { id: "verde-1", color: "Verde" };
const verde2: Photo = { id: "verde-2", color: "Verde" };
const azul: Photo = { id: "azul", color: "Azul" };
const geral1: Photo = { id: "geral-1", color: null };
const geral2: Photo = { id: "geral-2", color: null };

function ids(photos: readonly Photo[]): string[] {
  return photos.map((photo) => photo.id);
}

describe("findColorAxis", () => {
  it("acha o eixo de cor independentemente de caixa e acento", () => {
    expect(findColorAxis(["Cor", "tamanho"])).toBe("Cor");
    expect(findColorAxis(["COR"])).toBe("COR");
    expect(findColorAxis(["côr"])).toBe("côr");
    expect(findColorAxis([" cor "])).toBe(" cor ");
  });

  it("devolve o primeiro eixo de cor quando há mais de um", () => {
    expect(findColorAxis(["tamanho", "cor", "Cor"])).toBe("cor");
  });

  it("devolve null para produto sem eixo de cor", () => {
    expect(findColorAxis(["tamanho"])).toBe(null);
    expect(findColorAxis([])).toBe(null);
  });

  it("aguenta attributes_schema fora do formato esperado", () => {
    expect(findColorAxis(null)).toBe(null);
    expect(findColorAxis(undefined)).toBe(null);
    expect(findColorAxis("cor")).toBe(null);
    expect(findColorAxis([42, { nome: "cor" }])).toBe(null);
  });
});

describe("imagesForColor", () => {
  it("mostra as fotos da cor escolhida primeiro e depois as do produto inteiro", () => {
    const photos = [geral1, verde1, azul, verde2];
    expect(ids(imagesForColor(photos, "Verde"))).toEqual([
      "verde-1",
      "verde-2",
      "geral-1",
    ]);
  });

  it("esconde as fotos das outras cores", () => {
    const photos = [verde1, azul];
    expect(ids(imagesForColor(photos, "Azul"))).toEqual(["azul"]);
  });

  it("cai nas fotos do produto inteiro quando a cor não tem foto própria", () => {
    const photos = [verde1, geral1, geral2];
    expect(ids(imagesForColor(photos, "Azul"))).toEqual(["geral-1", "geral-2"]);
  });

  it("casa a cor mesmo com caixa e acento diferentes", () => {
    const photos = [{ id: "indigo", color: "Índigo" }, geral1];
    expect(ids(imagesForColor(photos, "indigo"))).toEqual([
      "indigo",
      "geral-1",
    ]);
    expect(ids(imagesForColor(photos, " ÍNDIGO "))).toEqual([
      "indigo",
      "geral-1",
    ]);
  });

  it("mostra tudo na ordem original quando não há cor escolhida", () => {
    const photos = [geral1, verde1, azul];
    expect(ids(imagesForColor(photos, null))).toEqual([
      "geral-1",
      "verde-1",
      "azul",
    ]);
    expect(ids(imagesForColor(photos, "  "))).toEqual([
      "geral-1",
      "verde-1",
      "azul",
    ]);
  });

  it("devolve lista vazia quando o produto não tem nenhuma foto", () => {
    expect(imagesForColor([], "Verde")).toEqual([]);
    expect(imagesForColor([], null)).toEqual([]);
  });

  it("não devolve a mesma lista recebida (a galeria não muta a origem)", () => {
    const photos = [geral1, verde1];
    const result = imagesForColor(photos, null);
    expect(result).not.toBe(photos);
    expect(result).toEqual(photos);
  });
});

describe("foto no corpo: política de proveniência", () => {
  const real1 = { id: "r1", origin: "upload", color: "Areia" };
  const ai1 = { id: "a1", origin: "ai", color: "Areia" };
  const real2 = { id: "r2", origin: "upload", color: null };
  const ai2 = { id: "a2", origin: "ai", color: "Terracota" };
  const all = [real1, ai1, real2, ai2];

  it("hide tira as fotos de IA; prefer põe as de IA na frente, sem mudar a ordem dentro de cada grupo", () => {
    expect(orderImagesByPolicy(all, "hide").map((image) => image.id)).toEqual(["r1", "r2"]);
    expect(orderImagesByPolicy(all, "prefer").map((image) => image.id)).toEqual(["a1", "a2", "r1", "r2"]);
    expect(orderImagesByPolicy([], "prefer")).toEqual([]);
  });

  it("a capa prefere a foto no corpo da cor; sem ela, a real; sem preferAi, sempre a real", () => {
    expect(pickCoverImage(all, { preferAi: true })?.id).toBe("a1");
    expect(pickCoverImage(all, { preferAi: true, color: "Terracota" })?.id).toBe("a2");
    // Cor sem foto própria cai nas do produto inteiro: a real r2.
    expect(pickCoverImage(all, { preferAi: true, color: "Verde" })?.id).toBe("r2");
    expect(pickCoverImage(all, { preferAi: false })?.id).toBe("r1");
    expect(pickCoverImage(all, { preferAi: false, color: "Terracota" })?.id).toBe("r2");
    expect(pickCoverImage([real1, real2], { preferAi: true })?.id).toBe("r1");
    expect(pickCoverImage([], { preferAi: true })).toBeNull();
    expect(isAiImage(ai1)).toBe(true);
    expect(isAiImage(real1)).toBe(false);
  });
});
