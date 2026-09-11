import { describe, expect, it } from "vitest";

import { cardDimensions, cardFrameSize, catalogCardEyebrow, catalogCardTitle, lookCardTitle } from "@/core/cards/types";

describe("cartão editorial — títulos e molduras", () => {
  it("título conta as peças por extenso e nunca passa de três", () => {
    expect(catalogCardTitle(1)).toBe("Uma peça para você");
    expect(catalogCardTitle(2)).toBe("Duas peças para você");
    expect(catalogCardTitle(3)).toBe("Três peças para você");
    expect(catalogCardTitle(9)).toBe("Três peças para você");
    expect(catalogCardTitle(0)).toBe("Uma peça para você");
  });

  it("eyebrow vem dos filtros da vendedora, em caixa alta e sem os rótulos", () => {
    expect(catalogCardEyebrow([])).toBe("A VITRINE DE HOJE");
    expect(catalogCardEyebrow(["categoria vestidos", "cor Preto", "até R$ 300,00", '"linho"'])).toBe(
      "VESTIDOS · PRETO · ATÉ R$ 300,00 · LINHO",
    );
    expect(catalogCardEyebrow(["categoria " + "x".repeat(80)])).toHaveLength(60);
  });

  it("look ganha título com a peça", () => {
    expect(lookCardTitle("Vestido Dunas")).toBe("Um look com Vestido Dunas");
  });

  it("molduras são 3:4 e cabem na largura de 1080", () => {
    for (const [kind, role, count] of [
      ["catalog", "item", 3],
      ["catalog", "item", 2],
      ["catalog", "item", 1],
      ["look", "hero", 1],
      ["look", "complement", 1],
    ] as const) {
      const size = cardFrameSize(kind, role, count);
      expect(size.height / size.width).toBeCloseTo(4 / 3, 1);
    }
    expect(cardFrameSize("catalog", "item", 3).width * 3 + 60).toBeLessThanOrEqual(1080 - 80);
    expect(cardFrameSize("look", "hero", 1).width + cardFrameSize("look", "complement", 1).width + 40).toBeLessThanOrEqual(1080 - 80);
  });
});

describe("cardDimensions / cardFrameSize dos formatos novos", () => {
  it("post e catálogo são 4:5; story é 9:16", () => {
    expect(cardDimensions("catalog")).toEqual({ width: 1080, height: 1350 });
    expect(cardDimensions("look")).toEqual({ width: 1080, height: 1350 });
    expect(cardDimensions("post")).toEqual({ width: 1080, height: 1350 });
    expect(cardDimensions("story")).toEqual({ width: 1080, height: 1920 });
  });

  it("a peça do post e do story ocupa a tela, com respiro para faixa e rodapé", () => {
    const post = cardFrameSize("post", "hero", 1);
    const story = cardFrameSize("story", "hero", 1);
    expect(post.width).toBeLessThan(1080);
    expect(post.height).toBeLessThan(1350);
    expect(story.height).toBeGreaterThan(post.height);
    // 3:4 em ambos (é a proporção da foto recortada).
    expect(Math.round((post.height / post.width) * 100) / 100).toBe(1.33);
    expect(Math.round((story.height / story.width) * 100) / 100).toBe(1.33);
  });
});
