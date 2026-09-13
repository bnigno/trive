// A linha das Edições de Belém no Bom dia (PURA): no ar > começa hoje > a
// próxima; plural certo; sem edição, nada.
import { describe, expect, it } from "vitest";

import { editionDigestLine, editionHeadline } from "@/core/digest/editions";
import { normalizeReceiptText } from "@/core/receipts/types";

describe("editionDigestLine", () => {
  it("vigente vence a futura; futura mais próxima; hoje; singular/plural; sem foto só quando falta", () => {
    expect(
      editionDigestLine([
        { name: "Natal", isCurrent: false, daysUntil: 100, products: 3, missingPhoto: 0 },
        { name: "Edição Círio", isCurrent: true, daysUntil: 0, products: 12, missingPhoto: 2 },
      ]),
    ).toBe("A Edição Círio está no ar com 12 peças, 2 ainda sem foto");
    expect(
      editionDigestLine([
        { name: "Natal", isCurrent: false, daysUntil: 100, products: 3, missingPhoto: 0 },
        { name: "Edição Círio", isCurrent: false, daysUntil: 28, products: 12, missingPhoto: 1 },
      ]),
    ).toBe("Faltam 28 dias para a Edição Círio — 12 peças escolhidas, 1 ainda sem foto");
    expect(editionDigestLine([{ name: "Edição Círio", isCurrent: false, daysUntil: 1, products: 1, missingPhoto: 0 }])).toBe("Falta 1 dia para a Edição Círio — 1 peça escolhida");
    expect(editionDigestLine([{ name: "Edição Círio", isCurrent: false, daysUntil: 0, products: 5, missingPhoto: 0 }])).toBe("A Edição Círio começa hoje com 5 peças");
    expect(editionDigestLine([{ name: "Chuva das 14h", isCurrent: false, daysUntil: null, products: 5, missingPhoto: 0 }])).toBeNull();
    expect(editionDigestLine([])).toBeNull();
  });

  it("cabe na imagem sem emoji ou símbolo", () => {
    const line = editionDigestLine([{ name: "Edição Círio", isCurrent: false, daysUntil: 28, products: 12, missingPhoto: 2 }]) ?? "";
    expect(normalizeReceiptText(line)).toBe(line);
  });
});

describe("editionHeadline", () => {
  it("curta para o topo da imagem: no ar > hoje > faltam N dias; sem edição, nada", () => {
    expect(editionHeadline([{ name: "Edição Círio", isCurrent: true, daysUntil: 0, products: 1, missingPhoto: 0 }])).toBe("A Edição Círio está no ar");
    expect(editionHeadline([{ name: "Edição Círio", isCurrent: false, daysUntil: 0, products: 1, missingPhoto: 0 }])).toBe("A Edição Círio começa hoje");
    expect(editionHeadline([{ name: "Edição Círio", isCurrent: false, daysUntil: 1, products: 1, missingPhoto: 0 }])).toBe("Falta 1 dia para a Edição Círio");
    expect(editionHeadline([{ name: "Edição Círio", isCurrent: false, daysUntil: 28, products: 1, missingPhoto: 0 }])).toBe("Faltam 28 dias para a Edição Círio");
    expect(editionHeadline([])).toBeNull();
  });
});
