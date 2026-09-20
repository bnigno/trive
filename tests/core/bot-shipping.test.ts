// A guarda do frete no fechamento (incidente #1012, 2026-09-11): o pedido só
// nasce com a cotação que a cliente viu nesta conversa, para o CEP do
// endereço de entrega, ainda válida e com o mesmo preço de agora.
import { describe, expect, it } from "vitest";

import type { BotQuote } from "@/core/bot/memory";
import {
  confirmQuoteUnchanged,
  formatQuoteLines,
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
    if (!nenhuma.ok) {
      expect(nenhuma.text).toContain("Nenhuma faixa cobre mais o CEP 01310-100");
      expect(nenhuma.text).toContain("transferir_para_atendente");
    }

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

  it("cotação automática dos Correios reemitida (id novo, mesmo nome): fecha com a fresca se o preço é o mesmo; preço diferente recusa", () => {
    // O cache da SuperFrete renova a cada 12 h e os ids mudam — o serviço é o mesmo.
    const approved: BotQuote = { ...SEDEX, rateId: "q-velha", optionKey: "q-velha", kind: "correios" };
    const reissued: BotQuote = { ...SEDEX, rateId: "q-nova", optionKey: "q-nova", kind: "correios" };
    expect(confirmQuoteUnchanged(approved, [{ ...PAC, rateId: "q-pac", optionKey: "q-pac", kind: "correios" }, reissued], "01310100")).toEqual({ ok: true, quote: reissued });

    const dearer = confirmQuoteUnchanged(approved, [{ ...reissued, priceCents: 3490 }], "01310100");
    expect(dearer.ok).toBe(false);
    if (!dearer.ok) expect(dearer.text).toContain(`mudou de ${formatCentsBRL(2990)} para ${formatCentsBRL(3490)}`);

    // Caderninho antigo (sem kind) também é Correios quando não tem janela.
    expect(confirmQuoteUnchanged({ ...SEDEX, rateId: "q-velha" }, [reissued], "01310100")).toEqual({ ok: true, quote: reissued });
  });
});

const MOTO_19: BotQuote = {
  rateId: "r-moto",
  name: "Motoboy",
  priceCents: 1500,
  deliveryDaysMin: 0,
  deliveryDaysMax: 0,
  optionKey: "r-moto:2026-09-18:19:00",
  kind: "motoboy",
  label: "hoje, 19h–21h · pague até 13h",
  window: { dayKey: "2026-09-18", start: "19:00", end: "21:00", cutoff: "13:00" },
};
const MOTO_16: BotQuote = {
  ...MOTO_19,
  optionKey: "r-moto:2026-09-18:16:00",
  label: "hoje, 16h–19h · pague até 13h",
  window: { dayKey: "2026-09-18", start: "16:00", end: "19:00", cutoff: "13:00" },
};

describe("janelas do motoboy (I4)", () => {
  it("o casamento pelo nome é só dos Correios: janela do motoboy que sumiu continua recusada", () => {
    const outraJanela = { ...MOTO_19, rateId: "r-moto-2", optionKey: "r-moto-2:2026-09-18:19:00" };
    const result = confirmQuoteUnchanged(MOTO_19, [outraJanela], "66045335");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.text).toContain("não está mais disponível");
  });

  it("formatQuoteLines mostra a janela e a hora-limite; com data marcada, o 'chega dia'", () => {
    expect(formatQuoteLines([PAC, MOTO_19])).toEqual([
      `1. PAC — ${formatCentsBRL(1990)} (5-8 dias úteis)`,
      `2. Motoboy — hoje, 19h–21h — ${formatCentsBRL(1500)} (pague até 13h)`,
    ]);
    expect(formatQuoteLines([{ ...PAC, arrival: "Chega até sexta 25/09, 3 dias antes" }])[0]).toContain("· Chega até sexta 25/09, 3 dias antes");
  });

  it("pickChosenQuote: duas janelas do mesmo motoboy — 'motoboy' sozinho é ambíguo; 'motoboy 19h', o número ou a chave escolhem", () => {
    const quotes = [MOTO_16, MOTO_19, PAC];
    expect(pickChosenQuote(quotes, "motoboy", undefined)).toEqual({ kind: "unrecognized", term: "motoboy" });
    expect(pickChosenQuote(quotes, "motoboy 19h", undefined)).toEqual({ kind: "picked", quote: MOTO_19 });
    expect(pickChosenQuote(quotes, "a das 16h", undefined)).toEqual({ kind: "picked", quote: MOTO_16 });
    expect(pickChosenQuote(quotes, "2", undefined)).toEqual({ kind: "picked", quote: MOTO_19 });
    expect(pickChosenQuote(quotes, undefined, "r-moto:2026-09-18:16:00")).toEqual({ kind: "picked", quote: MOTO_16 });
    // A hora não vence o resto do termo: "amanhã" não está em nenhuma janela de hoje; "19" solto não é escolha.
    expect(pickChosenQuote(quotes, "motoboy amanhã 19h", undefined)).toEqual({ kind: "unrecognized", term: "motoboy amanhã 19h" });
    expect(pickChosenQuote(quotes, "19", undefined)).toEqual({ kind: "unrecognized", term: "19" });
    expect(pickChosenQuote(quotes, "motoboy hoje 19h", undefined)).toEqual({ kind: "picked", quote: MOTO_19 });
    expect(pickChosenQuote(quotes, undefined, undefined)).toEqual({ kind: "missing" });
    // Estado antigo: só rateId como chave.
    expect(pickChosenQuote(QUOTES, undefined, "r-sedex")).toEqual({ kind: "picked", quote: SEDEX });
  });

  it("confirmQuoteUnchanged casa pela chave da opção: janela que passou da hora-limite manda cotar de novo", () => {
    const sumiu = confirmQuoteUnchanged(MOTO_19, [MOTO_16, PAC], "66050000");
    expect(sumiu.ok).toBe(false);
    if (!sumiu.ok) expect(sumiu.text).toContain("A janela do motoboy (hoje, 19h–21h · pague até 13h) já passou da hora-limite");
    // A faixa inteira sumiu (dona desativou): não é hora-limite.
    const faixaSumiu = confirmQuoteUnchanged(MOTO_19, [PAC], "66050000");
    expect(faixaSumiu.ok).toBe(false);
    if (!faixaSumiu.ok) expect(faixaSumiu.text).toContain("não está mais disponível");
    expect(confirmQuoteUnchanged(MOTO_19, [MOTO_16, MOTO_19, PAC], "66050000")).toEqual({ ok: true, quote: MOTO_19 });
  });
});
