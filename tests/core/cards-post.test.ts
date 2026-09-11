// A legenda do post (PURA): tom da maison, hashtags de Belém e o link da
// peça sempre no fim.
import { describe, expect, it } from "vitest";

import {
  BELEM_HASHTAGS,
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
