// Montar o look: complementos honestos (categoria diferente e complementar,
// com foto e estoque, preço na vizinhança, dentro do orçamento) — ou nada.
import { describe, expect, it } from "vitest";

import { lookFamilyOf, pickLookComplements, type LookCandidate } from "@/core/bot/look";

function candidate(over: Partial<LookCandidate> & { id: string; name: string }): LookCandidate {
  return {
    slug: over.id,
    categoryName: "Vestuário",
    priceCents: 15000,
    available: true,
    imagePath: `products/${over.id}-full.webp`,
    ...over,
  };
}

const hero = { id: "dunas", name: "LONGO DUNAS", categoryName: "Vestuário", priceCents: 30900 };

describe("lookFamilyOf", () => {
  it("lê a família pelo nome antes da categoria genérica e exclui utilidades", () => {
    expect(lookFamilyOf("Vestuário", "LONGO DUNAS")).toBe("vestido");
    expect(lookFamilyOf("Acessórios", "Bolsa Tote de Algodão")).toBe("bolsa");
    expect(lookFamilyOf("Acessórios", "Boné Bordado")).toBe("acessorio");
    expect(lookFamilyOf("Vestuário", "Camiseta Essencial")).toBe("top");
    expect(lookFamilyOf("Vestuário", "Meia Cano Alto")).toBe("acessorio");
    expect(lookFamilyOf("Casa", "Caneca de Cerâmica")).toBeNull();
    expect(lookFamilyOf("Casa", "Garrafa Térmica 500ml")).toBeNull();
    expect(lookFamilyOf(null, "Kit de Adesivos")).toBeNull();
  });
});

describe("pickLookComplements", () => {
  it("prefere famílias complementares na ordem, categorias distintas, preço próximo", () => {
    const picks = pickLookComplements(hero, [
      candidate({ id: "bolsa", name: "Bolsa Tote de Algodão", categoryName: "Acessórios", priceCents: 12900 }),
      candidate({ id: "bone", name: "Boné Bordado", categoryName: "Acessórios", priceCents: 8900 }),
      candidate({ id: "camiseta", name: "Camiseta Essencial", priceCents: 7900 }),
      candidate({ id: "outro-vestido", name: "Vestido Midi", priceCents: 25000 }),
      candidate({ id: "caneca", name: "Caneca de Cerâmica", categoryName: "Casa", priceCents: 3900 }),
    ]);
    expect(picks.map((pick) => pick.item.id)).toEqual(["bolsa", "bone"]);
    expect(picks[0]?.reason).toContain("completa a peça");
  });

  it("nunca a própria peça, a mesma família, esgotada ou sem foto", () => {
    const picks = pickLookComplements(hero, [
      candidate({ id: "dunas", name: "LONGO DUNAS" }),
      candidate({ id: "midi", name: "Vestido Midi Areia" }),
      candidate({ id: "bolsa-esgotada", name: "Bolsa Clutch", categoryName: "Acessórios", available: false }),
      candidate({ id: "bolsa-sem-foto", name: "Bolsa Baú", categoryName: "Acessórios", imagePath: null }),
    ]);
    expect(picks).toEqual([]);
  });

  it("respeita o orçamento total (peça + complementos) e o máximo pedido", () => {
    const candidates = [
      candidate({ id: "bolsa", name: "Bolsa Tote", categoryName: "Acessórios", priceCents: 12900 }),
      candidate({ id: "sandalia", name: "Sandália Rasteira", categoryName: "Calçados", priceCents: 19900 }),
      candidate({ id: "brinco", name: "Brinco Argola", categoryName: "Acessórios", priceCents: 4900 }),
    ];
    const within = pickLookComplements(hero, candidates, { budgetCents: 30900 + 13000 });
    expect(within.map((pick) => pick.item.id)).toEqual(["bolsa"]);
    const one = pickLookComplements(hero, candidates, { max: 1 });
    expect(one).toHaveLength(1);
  });

  it("peça sem família conhecida ainda ganha complementos de outra categoria", () => {
    const picks = pickLookComplements(
      { id: "x", name: "Peça Misteriosa", categoryName: "Novidades", priceCents: 20000 },
      [candidate({ id: "bolsa", name: "Bolsa Tote", categoryName: "Acessórios", priceCents: 12900 })],
    );
    expect(picks.map((pick) => pick.item.id)).toEqual(["bolsa"]);
    expect(picks[0]?.reason).toContain("outra categoria");
  });
});
