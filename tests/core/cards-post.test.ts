// A legenda do post (PURA): tom da maison, hashtags de Belém e o link da
// peça sempre no fim.
import { describe, expect, it } from "vitest";

import {
  BELEM_HASHTAGS,
  CAROUSEL_MAX,
  carouselColors,
  carouselEyebrow,
  buildPostCaption,
  hashtagFrom,
  POST_CAPTION_MAX,
  postEyebrow,
} from "@/core/cards/post";

const BASE = {
  name: "Longo Dunas",
  priceLabel: "R$ 289,00",
  categoryName: "Vestidos",
  editionName: "Edição Círio",
  storeName: "TRIVÉ",
  productUrl: "https://trivemaison.com.br/produto/longo-dunas",
};

describe("postEyebrow", () => {
  it("a edição em caixa alta; sem edição, a assinatura da casa", () => {
    expect(postEyebrow("Edição Círio")).toBe("EDIÇÃO CÍRIO");
    expect(postEyebrow("")).toBe("NOITE DE ESTREIA");
    expect(postEyebrow(null)).toBe("NOITE DE ESTREIA");
    expect(postEyebrow("x".repeat(60))).toHaveLength(40);
  });
});

describe("hashtagFrom", () => {
  it("junta as palavras com maiúscula e tira pontuação; vazio vira null", () => {
    expect(hashtagFrom("Edição Círio")).toBe("#EdiçãoCírio");
    expect(hashtagFrom("TRIVÉ")).toBe("#TRIVÉ");
    expect(hashtagFrom("  ")).toBeNull();
    expect(hashtagFrom("!!!")).toBeNull();
  });
});

describe("buildPostCaption", () => {
  it("abre com a peça e a edição, cita preço e sala, e termina no link", () => {
    const caption = buildPostCaption(BASE);
    expect(caption.startsWith("Longo Dunas — Edição Círio.")).toBe(true);
    expect(caption).toContain("Vestidos para o calor de Belém, R$ 289,00.");
    expect(caption).toContain("#Belém");
    expect(caption).toContain("#EdiçãoCírio");
    expect(caption).toContain("#TRIVÉ");
    expect(caption.endsWith(BASE.productUrl)).toBe(true);
  });

  it("sem edição e sem sala: continua uma legenda inteira, com o link no fim", () => {
    const caption = buildPostCaption({ ...BASE, editionName: null, categoryName: null });
    expect(caption.startsWith("Longo Dunas.")).toBe(true);
    expect(caption).toContain("Para o calor de Belém, R$ 289,00.");
    expect(caption).not.toContain("#EdiçãoCírio");
    expect(caption.endsWith(BASE.productUrl)).toBe(true);
  });

  it("não repete hashtag e respeita o limite do Instagram, cortando hashtags antes do link", () => {
    const caption = buildPostCaption({ ...BASE, name: "P".repeat(2300) });
    expect(caption.length).toBeLessThanOrEqual(POST_CAPTION_MAX);
    expect(caption.endsWith(BASE.productUrl)).toBe(true);

    const semRepetir = buildPostCaption({ ...BASE, storeName: "Belém" });
    const belem = semRepetir.match(/#Belém(?![a-zA-ZÀ-ÿ])/g) ?? [];
    expect(belem).toHaveLength(1);
    expect(BELEM_HASHTAGS.length).toBeGreaterThan(3);
  });
});

describe("carouselColors", () => {
  const images = [
    { color: "Areia", storagePath: "products/dunas/areia-1-full.webp" },
    { color: "Terracota", storagePath: "products/dunas/terra-1-full.webp" },
    { color: null, storagePath: "products/dunas/geral-full.webp" },
  ];
  const variants = [
    { attributes: { cor: "Areia", tamanho: "P" }, activePriceCents: 28900 },
    { attributes: { cor: "Areia", tamanho: "M" }, activePriceCents: 30900 },
    { attributes: { cor: "Terracota", tamanho: "P" }, activePriceCents: 28900 },
  ];
  const colors = (plan: ReturnType<typeof carouselColors>) => plan.entries.map((entry) => entry.color);

  it("uma imagem por cor, na ordem das variações, sem repetir, com os preços daquela cor", () => {
    expect(carouselColors({ attributesSchema: ["cor", "tamanho"], variants, images })).toEqual({
      entries: [
        { color: "Areia", imagePath: "products/dunas/areia-1-full.webp", priceCents: [28900, 30900] },
        { color: "Terracota", imagePath: "products/dunas/terra-1-full.webp", priceCents: [28900] },
      ],
      omitted: [],
    });
  });

  it("peça sem eixo de cor não tem carrossel", () => {
    expect(carouselColors({ attributesSchema: ["tamanho"], variants, images })).toEqual({
      entries: [],
      omitted: [],
    });
  });

  it("'Areia', 'aréia ' e 'AREIA' são uma cor só, com a grafia da primeira variação", () => {
    const grafias = [
      { attributes: { cor: "Areia" } },
      { attributes: { cor: "aréia " } },
      { attributes: { cor: "AREIA" } },
      { attributes: { cor: "Terracota" } },
    ];
    expect(colors(carouselColors({ attributesSchema: ["cor"], variants: grafias, images }))).toEqual([
      "Areia",
      "Terracota",
    ]);
  });

  it("variação desativada não entra, mesmo com foto própria; cor só em variação inativa some", () => {
    const comInativa = [
      { attributes: { cor: "Areia" } },
      { attributes: { cor: "Terracota" }, isActive: false },
      { attributes: { cor: "Verde" } },
    ];
    const fotos = [...images, { color: "Verde", storagePath: "products/dunas/verde-full.webp" }];
    expect(colors(carouselColors({ attributesSchema: ["cor"], variants: comInativa, images: fotos }))).toEqual([
      "Areia",
      "Verde",
    ]);
  });

  it("cor sem preço ativo não entra (a vitrine não vende); preço não informado não impede", () => {
    const semPreco = [
      { attributes: { cor: "Areia" }, activePriceCents: 28900 },
      { attributes: { cor: "Terracota" }, activePriceCents: null },
      { attributes: { cor: "Verde" } },
    ];
    const fotos = [...images, { color: "Verde", storagePath: "products/dunas/verde-full.webp" }];
    const plan = carouselColors({ attributesSchema: ["cor"], variants: semPreco, images: fotos });
    expect(colors(plan)).toEqual(["Areia", "Verde"]);
    expect(plan.entries[1].priceCents).toEqual([]);
  });

  it("cor sem foto própria fica de fora: a foto geral repetida não é carrossel", () => {
    // Verde só tem a foto geral → fora; sobra uma cor → não é carrossel.
    expect(
      carouselColors({
        attributesSchema: ["cor"],
        variants: [{ attributes: { cor: "Areia" } }, { attributes: { cor: "Verde" } }],
        images,
      }),
    ).toEqual({ entries: [], omitted: [] });
    // Sem foto nenhuma, idem.
    expect(
      carouselColors({ attributesSchema: ["cor"], variants: [{ attributes: { cor: "Verde" } }], images: [] }),
    ).toEqual({ entries: [], omitted: [] });
  });

  it("uma cor só não é carrossel: o post da peça já mostra essa cor", () => {
    const umaCor = [
      { attributes: { cor: "Areia", tamanho: "P" } },
      { attributes: { cor: "Areia", tamanho: "M" } },
    ];
    expect(carouselColors({ attributesSchema: ["cor", "tamanho"], variants: umaCor, images })).toEqual({
      entries: [],
      omitted: [],
    });
  });

  it("respeita o teto do Instagram: ficam as primeiras cores e as demais são nomeadas", () => {
    const muitas = Array.from({ length: 13 }, (_, i) => ({ attributes: { cor: `Cor ${i}` } }));
    const fotos = muitas.map((v, i) => ({ color: `Cor ${i}`, storagePath: `p/${i}.webp` }));
    const plan = carouselColors({ attributesSchema: ["cor"], variants: muitas, images: fotos });
    expect(plan.entries).toHaveLength(CAROUSEL_MAX);
    expect(colors(plan)).toEqual(Array.from({ length: CAROUSEL_MAX }, (_, i) => `Cor ${i}`));
    expect(plan.omitted).toEqual(["Cor 10", "Cor 11", "Cor 12"]);
  });

  it("a faixa do cartão diz a edição e a cor; quando não cabe, encurta a edição e nunca a cor", () => {
    expect(carouselEyebrow("Edição Círio", "Terracota")).toBe("EDIÇÃO CÍRIO · TERRACOTA");
    expect(carouselEyebrow("", "Areia")).toBe("NOITE DE ESTREIA · AREIA");
    const longa = carouselEyebrow("Edição Círio de Nazaré Noite de Estreia", "Terracota Queimada");
    expect(longa.length).toBeLessThanOrEqual(60);
    expect(longa.endsWith(" · TERRACOTA QUEIMADA")).toBe(true);
  });
});
