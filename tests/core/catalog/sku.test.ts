// Geração de SKU: o código é UNIQUE GLOBAL no banco, então a colisão precisa
// ser resolvida contra a tabela inteira antes do INSERT.
import { describe, expect, it } from "vitest";

import {
  abbreviateAxisValue,
  buildSku,
  dedupeSkus,
  skuBaseFromName,
} from "@/core/catalog/sku";

describe("skuBaseFromName", () => {
  it("tira acento e sobe para caixa alta", () => {
    expect(skuBaseFromName("Vestido Áurea")).toBe("VESTIDO-AUREA");
    expect(skuBaseFromName("calça jeans")).toBe("CALCA-JEANS");
  });

  it("separa palavras por hífen e descarta pontuação", () => {
    expect(skuBaseFromName("Blusa 100% seda — nova!")).toBe(
      "BLUSA-100-SEDA-NOVA",
    );
  });

  it("colapsa espaço duplo e apara as pontas", () => {
    expect(skuBaseFromName("  saia   longa  ")).toBe("SAIA-LONGA");
  });

  it("trunca na última palavra inteira que couber", () => {
    expect(skuBaseFromName("Vestido Longo Estampado Floral")).toBe(
      "VESTIDO-LONGO-ESTAMPADO",
    );
  });

  it("trunca no meio quando nem a primeira palavra cabe", () => {
    expect(skuBaseFromName("A".repeat(40))).toBe("A".repeat(24));
  });

  it("nome sem letra nem número cai no código de reserva", () => {
    expect(skuBaseFromName("###")).toBe("ITEM");
    expect(skuBaseFromName("   ")).toBe("ITEM");
  });
});

describe("abbreviateAxisValue", () => {
  it("uma palavra vira as primeiras letras", () => {
    expect(abbreviateAxisValue("Verde")).toBe("VERD");
    expect(abbreviateAxisValue("Vermelho")).toBe("VERM");
  });

  it("sigla de tamanho passa inteira", () => {
    expect(abbreviateAxisValue("P")).toBe("P");
    expect(abbreviateAxisValue("GG")).toBe("GG");
  });

  it("divide o orçamento de letras entre as palavras", () => {
    expect(abbreviateAxisValue("Azul Marinho")).toBe("AZMA");
    expect(abbreviateAxisValue("verde musgo escuro")).toBe("VME");
  });

  it("tira acento", () => {
    expect(abbreviateAxisValue("índigo")).toBe("INDI");
  });

  it("valor em branco vira vazio", () => {
    expect(abbreviateAxisValue("  ")).toBe("");
  });
});

describe("buildSku", () => {
  it("junta base e abreviação de cada eixo", () => {
    expect(buildSku("VESTIDO-AUREA", ["Verde", "P"])).toBe(
      "VESTIDO-AUREA-VERD-P",
    );
  });

  it("sem eixos devolve só a base", () => {
    expect(buildSku("VESTIDO-AUREA", [])).toBe("VESTIDO-AUREA");
  });

  it("eixo em branco não deixa hífen solto", () => {
    expect(buildSku("VESTIDO-AUREA", ["Verde", " "])).toBe(
      "VESTIDO-AUREA-VERD",
    );
  });

  it("base em branco cai no código de reserva", () => {
    expect(buildSku("  ", ["Verde"])).toBe("ITEM-VERD");
  });
});

describe("dedupeSkus", () => {
  it("mantém o candidato quando não há colisão", () => {
    expect(dedupeSkus(["BLUSA-VERD-P"], new Set())).toEqual(["BLUSA-VERD-P"]);
  });

  it("colisão com SKU já existente ganha sufixo -2", () => {
    expect(dedupeSkus(["BLUSA-VERD-P"], new Set(["BLUSA-VERD-P"]))).toEqual([
      "BLUSA-VERD-P-2",
    ]);
  });

  it("segue para -3 quando o -2 também está tomado", () => {
    expect(
      dedupeSkus(["BLUSA-VERD-P"], new Set(["BLUSA-VERD-P", "BLUSA-VERD-P-2"])),
    ).toEqual(["BLUSA-VERD-P-3"]);
  });

  it("candidatos iguais na mesma leva não colidem entre si", () => {
    expect(
      dedupeSkus(["BLUSA-VERD", "BLUSA-VERD", "BLUSA-VERD"], new Set()),
    ).toEqual(["BLUSA-VERD", "BLUSA-VERD-2", "BLUSA-VERD-3"]);
  });

  it("preserva a ordem dos candidatos", () => {
    expect(dedupeSkus(["A", "B", "A"], new Set(["B"]))).toEqual([
      "A",
      "B-2",
      "A-2",
    ]);
  });

  it("lista vazia devolve lista vazia", () => {
    expect(dedupeSkus([], new Set(["X"]))).toEqual([]);
  });
});
