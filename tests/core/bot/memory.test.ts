import { describe, expect, it } from "vitest";

import { formatCentsBRL } from "@/lib/money";
import {
  addNote,
  cartAdd,
  cartRemove,
  cartSubtotalCents,
  formatCartLines,
  NOTES_MAX,
  parseBotState,
  renderContextNote,
  type BotCartItem,
} from "@/core/bot/memory";

const VESTIDO: BotCartItem = {
  sku: "VEST-DUNAS-PRET-M",
  quantidade: 1,
  nome: "Vestido Dunas",
  variacao: "Preto · M",
  precoCents: 28900,
};

describe("parseBotState", () => {
  it("aceita jsonb vazio, nulo ou torto sem derrubar o turno", () => {
    expect(parseBotState(null)).toEqual({});
    expect(parseBotState(undefined)).toEqual({});
    expect(parseBotState({ cart: "não é lista" })).toEqual({});
  });

  it("preserva chaves desconhecidas (estado antigo continua legível)", () => {
    const state = parseBotState({ displayName: "Maria", legado: true });
    expect(state.displayName).toBe("Maria");
    expect((state as Record<string, unknown>).legado).toBe(true);
  });
});

describe("addNote", () => {
  it("anota sem repetir (ignorando caixa) e respeita o teto", () => {
    let notes = addNote(undefined, "veste M em vestidos");
    notes = addNote(notes, "Veste M em vestidos");
    expect(notes).toEqual(["Veste M em vestidos"]);

    for (let i = 0; i < NOTES_MAX + 3; i++) {
      notes = addNote(notes, `nota ${i}`);
    }
    expect(notes).toHaveLength(NOTES_MAX);
    expect(notes.at(-1)).toBe(`nota ${NOTES_MAX + 2}`);
  });

  it("nota vazia não entra", () => {
    expect(addNote(["a"], "   ")).toEqual(["a"]);
  });
});

describe("sacola", () => {
  it("soma quantidade do mesmo SKU (sem diferenciar caixa) e remove", () => {
    let cart = cartAdd(undefined, VESTIDO);
    cart = cartAdd(cart, { ...VESTIDO, sku: "vest-dunas-pret-m", quantidade: 2 });
    expect(cart).toHaveLength(1);
    expect(cart[0].quantidade).toBe(3);
    expect(cartSubtotalCents(cart)).toBe(86700);

    cart = cartRemove(cart, "VEST-DUNAS-PRET-M");
    expect(cart).toEqual([]);
  });

  it("formata linhas com variação e subtotal, e avisa sacola vazia", () => {
    expect(formatCartLines(undefined)).toEqual(["Sacola vazia."]);
    expect(formatCartLines([VESTIDO])).toEqual([
      `• 1× Vestido Dunas (Preto · M) — ${formatCentsBRL(28900)}`,
      `Subtotal: ${formatCentsBRL(28900)} (frete à parte)`,
    ]);
  });
});

describe("renderContextNote", () => {
  it("null quando não há nada a lembrar", () => {
    expect(renderContextNote({})).toBeNull();
  });

  it("monta o caderninho com nome, anotações, sacola, peça em vista, CEP e frete", () => {
    const note = renderContextNote({
      displayName: "Maria",
      notes: ["veste M em vestidos", "prefere tons terrosos"],
      cart: [VESTIDO],
      focus: { slug: "vestido-dunas", nome: "Vestido Dunas", cor: "Preto" },
      lastCep: "01310100",
      lastQuotes: [
        { rateId: "r1", name: "PAC", priceCents: 1990, deliveryDaysMin: 5, deliveryDaysMax: 8 },
        { rateId: "r2", name: "SEDEX", priceCents: 2990, deliveryDaysMin: 2, deliveryDaysMax: 2 },
      ],
      chosenRateId: "r2",
      lastOrderNumber: 1042,
    });
    expect(note).toContain("CADERNINHO");
    expect(note).toContain("• Nome no WhatsApp: Maria");
    expect(note).toContain("• Anotações: veste M em vestidos; prefere tons terrosos");
    expect(note).toContain(
      `• Sacola agora: 1× Vestido Dunas (Preto · M) — subtotal ${formatCentsBRL(28900)}`,
    );
    expect(note).toContain("• Peça em vista: Vestido Dunas (cor Preto)");
    expect(note).toContain(
      `• CEP informado: 01310-100 · frete cotado: PAC ${formatCentsBRL(1990)} (5-8 dias úteis), SEDEX ${formatCentsBRL(2990)} (2 dias úteis) · escolhido: SEDEX`,
    );
    expect(note).toContain("• Último pedido nesta conversa: #1042");
  });
});
