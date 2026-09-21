// A ponte do site (PURO): código de 4 símbolos sem ambiguidade, o código
// achado na mensagem, a mensagem pronta por origem e a linha do caderninho.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  BRIDGE_CODE_ALPHABET,
  BRIDGE_CODE_LENGTH,
  bridgeContextLine,
  buildBridgeMessage,
  CAMPAIGN_SLUG_RE,
  extractBridgeCode,
  generateBridgeCode,
  isBridgeCurrent,
  isBridgeFresh,
  normalizeCampaignSlug,
  isProvadorCampaign,
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
    // Checkout sem frete para o CEP: a mensagem leva o CEP para a Lia cotar (e a equipe calcular os Correios).
    expect(
      buildBridgeMessage({
        sellerName: "Lia",
        code: "AB23",
        source: "cart",
        items: [{ sku: "A", name: "Longo Dunas", variation: "", quantity: 1, priceCents: 1 }],
        cep: "01310100",
      }),
    ).toBe("Oi Lia, minha sacola no site: 1× Longo Dunas, entrega no CEP 01310-100 (#AB23)");
    expect(buildBridgeMessage({ sellerName: "", code: "K7F2", source: "footer" })).toBe("Oi Lia, vim pelo site (#K7F2)");
    expect(buildBridgeMessage({ sellerName: "Lia", code: "K7F2", source: "campaign", product: { name: "Longo Dunas" } })).toBe(
      "Oi Lia, vi o Longo Dunas no story (#K7F2)",
    );
    // Sacola vazia no toque: vira "vim pelo site"; story sem peça: "vim pelo story".
    expect(buildBridgeMessage({ sellerName: "Lia", code: "K7F2", source: "cart", items: [] })).toBe("Oi Lia, vim pelo site (#K7F2)");
    expect(buildBridgeMessage({ sellerName: "Lia", code: "K7F2", source: "campaign" })).toBe("Oi Lia, vim pelo story (#K7F2)");
    expect(originLabel("pdp")).toBe("página da peça");
    expect(originLabel("campaign", "Dunas no story")).toBe("story «Dunas no story»");
    expect(originLabel("campaign", "  ")).toBe("story");
    expect(originLabel("campaign")).toBe("story");
  });

  it("link do Provador (slug prov-…): a cliente 'vem pelo Provador' e a origem diz Provador, não story", () => {
    expect(isProvadorCampaign("prov-20260922-chegadas")).toBe(true);
    expect(isProvadorCampaign("provador")).toBe(false);
    expect(isProvadorCampaign(null)).toBe(false);
    expect(buildBridgeMessage({ sellerName: "Lia", code: "K7F2", source: "campaign", campaignSlug: "prov-20260922-chegadas", product: { name: "Vestido Terracota" } })).toBe(
      "Oi Lia, vi o Vestido Terracota no Provador (#K7F2)",
    );
    expect(buildBridgeMessage({ sellerName: "Lia", code: "K7F2", source: "campaign", campaignSlug: "prov-20260922-enquete" })).toBe("Oi Lia, vim pelo Provador (#K7F2)");
    // Slug comum continua story; fora de campaign o slug é ignorado.
    expect(buildBridgeMessage({ sellerName: "Lia", code: "K7F2", source: "campaign", campaignSlug: "dunas" })).toBe("Oi Lia, vim pelo story (#K7F2)");
    expect(buildBridgeMessage({ sellerName: "Lia", code: "K7F2", source: "footer", campaignSlug: "prov-x" })).toBe("Oi Lia, vim pelo site (#K7F2)");
    expect(originLabel("campaign", "chegadas 22/09", "prov-20260922-chegadas")).toBe("Provador «chegadas 22/09»");
    // Link apagado: o rótulo É o slug, e o slug ainda diz que era do Provador.
    expect(originLabel("campaign", "prov-20260922-chegadas")).toBe("Provador «prov-20260922-chegadas»");
    expect(originLabel("campaign", "Dunas", "dunas")).toBe("story «Dunas»");
  });
});

describe("normalizeCampaignSlug", () => {
  it("nome vira slug de URL; fora da regra (2–40, [a-z0-9-]) é null", () => {
    expect(normalizeCampaignSlug("Círio 2026")).toBe("cirio-2026");
    expect(normalizeCampaignSlug("  dunas ")).toBe("dunas");
    expect(normalizeCampaignSlug("Dunas — areia!")).toBe("dunas-areia");
    expect(normalizeCampaignSlug("a")).toBeNull();
    expect(normalizeCampaignSlug("!!!")).toBeNull();
    expect(normalizeCampaignSlug("")).toBeNull();
    expect(normalizeCampaignSlug("x".repeat(41))).toBeNull();
    expect(normalizeCampaignSlug("x".repeat(40))).toBe("x".repeat(40));
  });

  it("o slug normalizado sempre passa na regra do banco (fast-check)", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (raw) => {
        const slug = normalizeCampaignSlug(raw);
        return slug === null || CAMPAIGN_SLUG_RE.test(slug);
      }),
    );
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

describe("isBridgeCurrent", () => {
  it("vale por 24 h; depois o caderninho para de falar da ponte", () => {
    const now = new Date("2026-09-13T15:00:00Z");
    const bridge = (at: string) => ({ siteCartId: "x", code: "K7F2", source: "pdp" as const, at });
    expect(isBridgeCurrent(bridge("2026-09-12T15:00:00Z"), now)).toBe(true);
    expect(isBridgeCurrent(bridge("2026-09-12T14:59:59Z"), now)).toBe(false);
    expect(isBridgeCurrent(bridge("x"), now)).toBe(false);
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
