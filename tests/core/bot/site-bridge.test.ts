// A ponte do site (PURO): código de 4 símbolos sem ambiguidade, o código
// achado na mensagem, a mensagem pronta por origem e a linha do caderninho.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  BRIDGE_CODE_ALPHABET,
  BRIDGE_CODE_LENGTH,
  bridgeContextLine,
  buildBridgeMessage,
  extractBridgeCode,
  generateBridgeCode,
  isBridgeFresh,
  originLabel,
} from "@/core/bot/site-bridge";

describe("generateBridgeCode", () => {
  it("tem 4 símbolos do alfabeto, sem 0/O nem 1/I/L, para qualquer aleatório", () => {
    fc.assert(
      fc.property(fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 4, maxLength: 4 }), (draws) => {
        let index = 0;
        const code = generateBridgeCode(() => draws[index++ % draws.length]!);
        expect(code).toHaveLength(BRIDGE_CODE_LENGTH);
        for (const char of code) expect(BRIDGE_CODE_ALPHABET).toContain(char);
        expect(code).not.toMatch(/[01OIL]/);
      }),
    );
    expect(generateBridgeCode(() => 0)).toBe("AAAA");
    expect(generateBridgeCode(() => 0.999999)).toBe("9999");
    // Math.random de verdade também serve.
    expect(generateBridgeCode()).toMatch(/^[A-Z2-9]{4}$/);
  });
});

describe("extractBridgeCode", () => {
  it("acha o código na mensagem, em qualquer caixa, com ou sem espaço depois do #", () => {
    expect(extractBridgeCode("Oi Lia, vi o Longo Dunas em areia · m (#K7F2)")).toBe("K7F2");
    expect(extractBridgeCode("oi lia (#k7f2) tudo bem?")).toBe("K7F2");
    expect(extractBridgeCode("# K7F2")).toBe("K7F2");
    expect(extractBridgeCode("sem código aqui")).toBeNull();
    // Cinco símbolos não são um código; hashtag comum também não.
    expect(extractBridgeCode("#K7F2X")).toBeNull();
    expect(extractBridgeCode("#look do dia")).toBeNull();
    // Símbolos fora do alfabeto (0, O, I, L) não formam código.
    expect(extractBridgeCode("#K0F2")).toBeNull();
    // O site põe o código no FIM, entre parênteses: essa forma vence, e entre várias vale a última.
    expect(extractBridgeCode("#ABCD e #EFGH")).toBe("EFGH");
    expect(extractBridgeCode("#natal Oi Lia, vi o Longo Dunas (#K7F2)")).toBe("K7F2");
    expect(extractBridgeCode("(#ABCD) e depois #EFGH")).toBe("ABCD");
    // Hashtag maior que o código não é código ("#natal" começa com NATA).
    expect(extractBridgeCode("#natal oi lia")).toBeNull();
    expect(extractBridgeCode("#verão")).toBeNull();
    expect(extractBridgeCode("#desconto")).toBeNull();
  });

  it("nunca deixa o código do site para trás, seja o que for que a cliente escreva antes (fast-check)", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), fc.stringMatching(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/), (prefix, code) => {
        expect(extractBridgeCode(`${prefix} Oi Lia, vim pelo site (#${code})`)).toBe(code);
      }),
    );
  });
});

describe("buildBridgeMessage / originLabel", () => {
  it("peça com variação, peça sem variação, sacola, rodapé e story", () => {
    expect(buildBridgeMessage({ sellerName: "Lia", code: "K7F2", source: "pdp", product: { name: "Longo Dunas", variation: "Areia · M" } })).toBe(
      "Oi Lia, vi o Longo Dunas em areia · m (#K7F2)",
    );
    expect(buildBridgeMessage({ sellerName: "Lia", code: "K7F2", source: "pdp", product: { name: "Longo Dunas" } })).toBe("Oi Lia, vi o Longo Dunas (#K7F2)");
    expect(
      buildBridgeMessage({
        sellerName: "Marina",
        code: "AB23",
        source: "cart",
        items: [
          { sku: "A", name: "Longo Dunas", variation: "Areia · M", quantity: 1, priceCents: 1 },
          { sku: "B", name: "Bolsa Tote", variation: "", quantity: 2, priceCents: 1 },
        ],
      }),
    ).toBe("Oi Marina, minha sacola no site: 1× Longo Dunas em areia · m, 2× Bolsa Tote (#AB23)");
    expect(buildBridgeMessage({ sellerName: "", code: "K7F2", source: "footer" })).toBe("Oi Lia, vim pelo site (#K7F2)");
    expect(buildBridgeMessage({ sellerName: "Lia", code: "K7F2", source: "campaign", product: { name: "Longo Dunas" } })).toBe(
      "Oi Lia, vi o Longo Dunas no story (#K7F2)",
    );
    // Sacola vazia no toque: vira "vim pelo site".
    expect(buildBridgeMessage({ sellerName: "Lia", code: "K7F2", source: "cart", items: [] })).toBe("Oi Lia, vim pelo site (#K7F2)");
    expect(originLabel("pdp")).toBe("página da peça");
    expect(originLabel("campaign", "verao")).toBe("story «verao»");
    expect(originLabel("campaign")).toBe("story");
  });
});

describe("bridgeContextLine", () => {
  const now = new Date("2026-09-12T15:00:00Z");
  it("diz de onde veio, quando, e o que estava vendo", () => {
    expect(
      bridgeContextLine(
        { siteCartId: "x", code: "K7F2", source: "pdp", at: "2026-09-12T14:59:00Z", productName: "Longo Dunas", variation: "Areia · M" },
        now,
      ),
    ).toBe("Veio do site agora (página da peça): Longo Dunas (Areia · M)");
    expect(
      bridgeContextLine(
        {
          siteCartId: "x",
          code: "K7F2",
          source: "cart",
          at: "2026-09-12T14:20:00Z",
          items: [{ sku: "A", name: "Longo Dunas", variation: "Areia · M", quantity: 1, priceCents: 1 }],
        },
        now,
      ),
    ).toBe("Veio do site há 40 min (sacola) com a sacola: 1× Longo Dunas (Areia · M)");
    // Página da peça guarda a foto da peça em `items` (para o estoque): a frase continua sendo da peça, não "sacola".
    expect(
      bridgeContextLine(
        {
          siteCartId: "x",
          code: "K7F2",
          source: "pdp",
          at: "2026-09-12T14:59:00Z",
          productName: "Longo Dunas",
          variation: "Areia · M",
          items: [{ sku: "A", name: "Longo Dunas", variation: "Areia · M", quantity: 1, priceCents: 1 }],
        },
        now,
      ),
    ).toBe("Veio do site agora (página da peça): Longo Dunas (Areia · M)");
    expect(bridgeContextLine({ siteCartId: "x", code: "K7F2", source: "footer", at: "2026-09-12T10:00:00Z" }, now)).toBe("Veio do site há 5 h (rodapé do site)");
    expect(bridgeContextLine({ siteCartId: "x", code: "K7F2", source: "campaign", sourceLabel: "story «verao»", at: "2026-09-10T10:00:00Z" }, now)).toBe(
      "Veio do site há 2 dia(s) (story «verao»)",
    );
  });
});

describe("isBridgeFresh", () => {
  const now = new Date("2026-09-12T15:00:00Z");
  const bridge = (at: string) => ({ siteCartId: "x", code: "K7F2", source: "pdp" as const, at });

  it("até 1 h vale conferir o estoque; depois, não; data torta é velha", () => {
    expect(isBridgeFresh(bridge("2026-09-12T14:00:00Z"), now)).toBe(true);
    expect(isBridgeFresh(bridge("2026-09-12T13:59:59Z"), now)).toBe(false);
    expect(isBridgeFresh(bridge("2026-09-12T15:00:00Z"), now)).toBe(true);
    expect(isBridgeFresh(bridge("nunca"), now)).toBe(false);
  });
});
