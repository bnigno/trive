import { describe, expect, it } from "vitest";

import { formatCentsBRL } from "@/lib/money";
import {
  addNote,
  cartAdd,
  cartRemove,
  CART_MAX_QTY,
  cartSubtotalCents,
  formatCartLines,
  NOTES_MAX,
  mergeBridgeIntoState,
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

  it("linha nova acima do teto é cortada (a ponte do site pode trazer 24; o caderninho aceita até 20)", () => {
    const cart = cartAdd(undefined, { ...VESTIDO, quantidade: 24 });
    expect(cart[0].quantidade).toBe(CART_MAX_QTY);
    expect(parseBotState({ cart })).toEqual({ cart });
  });

  it("formata linhas com variação e subtotal, e avisa sacola vazia", () => {
    expect(formatCartLines(undefined)).toEqual(["Sacola vazia."]);
    expect(formatCartLines([VESTIDO])).toEqual([
      `• 1× Vestido Dunas (Preto · M) — ${formatCentsBRL(28900)}`,
      `Subtotal: ${formatCentsBRL(28900)} (frete à parte)`,
    ]);
  });
});

describe("mergeBridgeIntoState", () => {
  const AT = "2026-09-12T14:59:30Z";

  it("página da peça: a peça vira 'em vista' e a sacola atual fica como está", () => {
    const merged = mergeBridgeIntoState(
      { cart: [VESTIDO], focus: { slug: "outra", nome: "Outra", cor: "Azul" } },
      { siteCartId: "s1", code: "K7F2", source: "pdp", at: AT, productSlug: "longo-dunas", productName: "Longo Dunas", variation: "Areia · M" },
    );
    expect(merged.focus).toEqual({ slug: "longo-dunas", nome: "Longo Dunas", cor: null });
    expect(merged.cart).toEqual([VESTIDO]);
    expect(merged.bridge?.code).toBe("K7F2");
  });

  it("sacola do site: funde na sacola da conversa por SKU (soma quantidade, não duplica) e não mexe na peça em vista", () => {
    const merged = mergeBridgeIntoState(
      { cart: [VESTIDO], focus: { slug: "outra", nome: "Outra", cor: null } },
      {
        siteCartId: "s2",
        code: "M3PQ",
        source: "cart",
        at: AT,
        items: [
          { sku: "VEST-DUNAS-PRET-M", name: "Vestido Dunas", variation: "Preto · M", quantity: 2, priceCents: 28900 },
          { sku: "TOTE", name: "Bolsa Tote", variation: "", quantity: 1, priceCents: 12900 },
        ],
      },
    );
    expect(merged.cart).toEqual([
      { ...VESTIDO, quantidade: 3 },
      { sku: "TOTE", quantidade: 1, nome: "Bolsa Tote", variacao: "", precoCents: 12900 },
    ]);
    expect(merged.focus).toEqual({ slug: "outra", nome: "Outra", cor: null });
  });

  it("rodapé sem peça: só registra a ponte; segunda ponte substitui a primeira", () => {
    const first = mergeBridgeIntoState({}, { siteCartId: "s3", code: "AAAA", source: "footer", at: AT });
    expect(first).toEqual({ bridge: { siteCartId: "s3", code: "AAAA", source: "footer", at: AT } });
    const second = mergeBridgeIntoState(first, { siteCartId: "s4", code: "BBBB", source: "campaign", sourceLabel: "story dunas", at: AT, productSlug: "longo-dunas", productName: "Longo Dunas" });
    expect(second.bridge?.siteCartId).toBe("s4");
    expect(second.focus?.slug).toBe("longo-dunas");
  });
});

describe("renderContextNote", () => {
  it("a ponte do site vem primeiro: 'Veio do site' antes de tudo", () => {
    const note = renderContextNote(
      {
        displayName: "Ana",
        bridge: { siteCartId: "x", code: "K7F2", source: "pdp", at: "2026-09-12T14:59:30Z", productName: "Longo Dunas", variation: "Areia · M" },
      },
      { now: new Date("2026-09-12T15:00:00Z") },
    )!;
    const lines = note.split("\n");
    expect(lines[1]).toBe("• Nome no WhatsApp: Ana");
    expect(lines[2]).toBe("• Veio do site agora (página da peça): Longo Dunas (Areia · M)");
  });

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

  it("CEP sem cotação (a sacola mudou): avisa que o frete ainda NÃO foi cotado", () => {
    const note = renderContextNote({ lastCep: "68795000" });
    expect(note).toContain(
      "• CEP informado: 68795-000 · frete ainda NÃO cotado para a sacola atual — chame cotar_frete antes do resumo",
    );
    expect(note).not.toContain("escolhido");
  });

  it("endereço do CEP entra no caderninho pedindo só número e complemento", () => {
    const note = renderContextNote({
      lastCep: "01310100",
      lastCepAddress: { street: "Avenida Paulista", district: "Bela Vista", city: "São Paulo", state: "SP" },
    });
    expect(note).toContain(
      "• Endereço do CEP: Avenida Paulista, Bela Vista — São Paulo/SP (peça só número e complemento)",
    );
    expect(parseBotState({ lastCep: "01310100" }).lastCepAddress).toBeUndefined();
  });

  it("cupom validado entra no caderninho com o desconto e a instrução para criar_pedido", () => {
    const state = parseBotState({
      coupon: { code: "BEMVINDA10", discountCents: 899, at: "2026-09-11T12:00:00.000Z" },
    });
    expect(state.coupon?.code).toBe("BEMVINDA10");
    const note = renderContextNote(state);
    expect(note).toContain(
      `• Cupom validado nesta conversa: BEMVINDA10 (desconto de ${formatCentsBRL(899)} nesta sacola) — criar_pedido aplica sozinho e recalcula no fechamento; para NÃO usar, passe cupom vazio ""`,
    );
    expect(renderContextNote({})).toBeNull();
  });

  it("guarda quando a cotação foi feita", () => {
    const state = parseBotState({ lastCep: "68795000", lastQuotedAt: "2026-09-11T12:00:00.000Z" });
    expect(state.lastQuotedAt).toBe("2026-09-11T12:00:00.000Z");
  });
});
