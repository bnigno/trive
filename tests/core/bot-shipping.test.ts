// A guarda do frete no fechamento (incidente #1012, 2026-09-11): o pedido só
// nasce com a cotação que a cliente viu nesta conversa, para o CEP do
// endereço de entrega, ainda válida e com o mesmo preço de agora.
import { describe, expect, it } from "vitest";

import type { BotQuote } from "@/core/bot/memory";
import {
  confirmQuoteUnchanged,
  pickChosenQuote,
  QUOTE_MAX_AGE_MS,
  resolveApprovedQuote,
} from "@/core/bot/shipping";
import { formatCentsBRL } from "@/lib/money";

const PAC: BotQuote = {
  rateId: "r-pac",
  name: "PAC",
  priceCents: 1990,
  deliveryDaysMin: 5,
  deliveryDaysMax: 8,
};
const SEDEX: BotQuote = {
  rateId: "r-sedex",
  name: "SEDEX",
  priceCents: 2990,
  deliveryDaysMin: 2,
  deliveryDaysMax: 2,
};
const QUOTES = [PAC, SEDEX];

describe("pickChosenQuote", () => {
  it("pelo número da lista, pelo nome sem caixa e por parte do nome", () => {
    expect(pickChosenQuote(QUOTES, "2", undefined)).toEqual({ kind: "picked", quote: SEDEX });
    expect(pickChosenQuote(QUOTES, "sedex", undefined)).toEqual({ kind: "picked", quote: SEDEX });
    expect(pickChosenQuote(QUOTES, "o PAC mesmo", undefined)).toEqual({ kind: "picked", quote: PAC });
  });

  it("termo que não é nenhuma das opções é 'unrecognized' — mesmo com uma opção só", () => {
    expect(pickChosenQuote(QUOTES, "Jadlog", undefined)).toEqual({
      kind: "unrecognized",
      term: "Jadlog",
    });
    // O caso do #1012: o modelo escreveu "Benevides" e só "Belém" tinha sido cotado.
    expect(pickChosenQuote([PAC], "Benevides", undefined)).toEqual({
      kind: "unrecognized",
      term: "Benevides",
    });
  });

  it("sem termo: uma opção é a escolha; nomes iguais vale a mais barata; senão o id escolhido; senão 'missing'", () => {
    expect(pickChosenQuote([PAC], undefined, undefined)).toEqual({ kind: "picked", quote: PAC });
    const pacCaro = { ...PAC, rateId: "r-pac-2", priceCents: 2490 };
    expect(pickChosenQuote([PAC, pacCaro], undefined, undefined)).toEqual({
      kind: "picked",
      quote: PAC,
    });
    expect(pickChosenQuote(QUOTES, undefined, "r-sedex")).toEqual({ kind: "picked", quote: SEDEX });
    expect(pickChosenQuote(QUOTES, undefined, "r-sumiu")).toEqual({ kind: "missing" });
    expect(pickChosenQuote(QUOTES, "   ", undefined)).toEqual({ kind: "missing" });
  });
});

describe("resolveApprovedQuote", () => {
  const base = {
    quotedCep: "01310100",
    quotes: QUOTES,
    chosenRateId: undefined,
    orderCep: "01310100",
    freteInput: "SEDEX",
  };

  it("sem cotação nesta conversa: recusa e manda cotar com o CEP do endereço", () => {
    const r = resolveApprovedQuote({ ...base, quotes: undefined, quotedCep: undefined });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.text).toContain("Ainda não há cotação de frete");
      expect(r.text).toContain("01310-100");
    }
    expect(resolveApprovedQuote({ ...base, quotes: [] }).ok).toBe(false);
  });

  it("cotação com mais de 24 h é recusada; recente (ou sem carimbo, estado antigo) passa", () => {
    const now = new Date("2026-09-11T15:00:00Z");
    const velha = new Date(now.getTime() - QUOTE_MAX_AGE_MS - 1).toISOString();
    const recente = new Date(now.getTime() - 60_000).toISOString();
    const r = resolveApprovedQuote({ ...base, quotedAt: velha, now });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.text).toContain("antiga");
    expect(resolveApprovedQuote({ ...base, quotedAt: recente, now }).ok).toBe(true);
    expect(resolveApprovedQuote({ ...base, now }).ok).toBe(true);
  });

  it("CEP cotado diferente do CEP do endereço: recusa citando os dois e o caminho de volta", () => {
    const r = resolveApprovedQuote({ ...base, quotedCep: "68795000", orderCep: "66045335" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.text).toContain("cotado para o CEP 68795-000");
      expect(r.text).toContain("CEP 66045-335");
      expect(r.text).toContain("cotar_frete");
      expect(r.text).toContain("passe esse endereço completo");
    }
  });

  it("frete que não é das opções cotadas: lista as opções e pede o nome exato", () => {
    const r = resolveApprovedQuote({ ...base, freteInput: "Benevides" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.text).toContain('"Benevides" não é nenhuma das cotadas');
      expect(r.text).toContain(`1. PAC — ${formatCentsBRL(1990)}`);
      expect(r.text).toContain(`2. SEDEX — ${formatCentsBRL(2990)}`);
    }
  });

  it("várias opções e nenhuma escolha: pede a escolha", () => {
    const r = resolveApprovedQuote({ ...base, freteInput: undefined });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.text).toContain("a escolha da cliente não veio");
  });

  it("tudo certo: devolve a cotação aprovada (CEP com máscara também vale)", () => {
    expect(resolveApprovedQuote({ ...base, orderCep: "01310-100", freteInput: "2" })).toEqual({
      ok: true,
      quote: SEDEX,
    });
  });
});

describe("confirmQuoteUnchanged", () => {
  it("sem tarifa para o CEP, tarifa que sumiu e preço que mudou são recusas com os valores", () => {
    const nenhuma = confirmQuoteUnchanged(SEDEX, [], "01310100");
    expect(nenhuma.ok).toBe(false);
    if (!nenhuma.ok) expect(nenhuma.text).toContain("Não entregamos");

    const sumiu = confirmQuoteUnchanged(SEDEX, [PAC], "01310100");
    expect(sumiu.ok).toBe(false);
    if (!sumiu.ok) {
      expect(sumiu.text).toContain("A opção SEDEX não está mais disponível para o CEP 01310-100");
    }

    const mudou = confirmQuoteUnchanged(SEDEX, [PAC, { ...SEDEX, priceCents: 3490 }], "01310100");
    expect(mudou.ok).toBe(false);
    if (!mudou.ok) {
      expect(mudou.text).toContain(`mudou de ${formatCentsBRL(2990)} para ${formatCentsBRL(3490)}`);
    }
  });

  it("igual: devolve a cotação FRESCA (mesmo id e preço), mesmo com a ordem de hoje diferente", () => {
    const fresh = [{ ...SEDEX, deliveryDaysMax: 3 }, PAC];
    expect(confirmQuoteUnchanged(SEDEX, fresh, "01310100")).toEqual({ ok: true, quote: fresh[0] });
  });
});
