import { describe, expect, it } from "vitest";
import { pickChosenQuote, confirmQuoteUnchanged } from "@/core/bot/shipping";
import type { BotQuote } from "@/core/bot/memory";

const pac: BotQuote = { rateId: "r-pac", name: "PAC", priceCents: 1990, deliveryDaysMin: 5, deliveryDaysMax: 8, optionKey: "r-pac", kind: "correios" };
const sedex: BotQuote = { rateId: "r-sedex", name: "SEDEX", priceCents: 2990, deliveryDaysMin: 1, deliveryDaysMax: 2, optionKey: "r-sedex", kind: "correios" };
function moto(rateId: string, day: string, start: string, end: string, cutoff: string, when: "hoje" | "amanhã", price = 1500): BotQuote {
  const h = (s: string) => { const [hh, mm] = s.split(":"); return mm === "00" ? `${Number(hh)}h` : `${Number(hh)}h${mm}`; };
  const label = when === "hoje" ? `hoje, ${h(start)}–${h(end)} · pague até ${h(cutoff)}` : `amanhã, ${h(start)}–${h(end)}`;
  return { rateId, name: "Motoboy", priceCents: price, deliveryDaysMin: 0, deliveryDaysMax: 0, optionKey: `${rateId}:${day}:${start}`, kind: "motoboy", label, window: { dayKey: day, start, end, cutoff } };
}
const m19 = moto("r-moto", "2026-09-13", "19:00", "21:00", "13:00", "hoje");
const m16 = moto("r-moto", "2026-09-13", "16:00", "19:00", "11:00", "hoje");
const m9am = moto("r-moto", "2026-09-14", "09:00", "12:00", "08:00", "amanhã");

const k = (r: ReturnType<typeof pickChosenQuote>) => r.kind === "picked" ? `picked:${r.quote.optionKey}` : r.kind;

describe("tmp pickChosenQuote", () => {
  it("scenarios", () => {
    const out: Record<string, string> = {};
    out["motoboy / 1 janela"] = k(pickChosenQuote([m19, pac], "motoboy", undefined));
    out["motoboy / 2 janelas"] = k(pickChosenQuote([m19, m16, pac], "motoboy", undefined));
    out["hoje / 1"] = k(pickChosenQuote([m19, pac], "hoje", undefined));
    out["hoje / 2 hoje"] = k(pickChosenQuote([m19, m16, pac], "hoje", undefined));
    out["19h"] = k(pickChosenQuote([m19, m16, pac], "19h", undefined));
    out["19"] = k(pickChosenQuote([m19, m16, pac], "19", undefined));
    out["19 / só m19"] = k(pickChosenQuote([m19, pac], "19", undefined));
    out["19 / só m16 (termina 19h)"] = k(pickChosenQuote([m16, pac], "19", undefined));
    out["a segunda"] = k(pickChosenQuote([m19, m16, pac], "a segunda", undefined));
    out["o mais barato"] = k(pickChosenQuote([m19, pac, sedex], "o mais barato", undefined));
    out["motoboy 19h / bandas iguais"] = k(pickChosenQuote([m19, { ...m19, rateId: "r-moto2", optionKey: "r-moto2:2026-09-13:19:00", priceCents: 2000 }, pac], "motoboy 19h", undefined));
    out["sem termo / bandas iguais"] = k(pickChosenQuote([m19, { ...m19, rateId: "r-moto2", optionKey: "r-moto2:2026-09-13:19:00", priceCents: 2000 }], undefined, undefined));
    out["Motoboy — hoje, 19h–21h — R$ 15,00 (pague até 13h)"] = k(pickChosenQuote([m19, m16, pac], "Motoboy — hoje, 19h–21h — R$ 15,00 (pague até 13h)", undefined));
    out["motoboy 19h-21h (hífen)"] = k(pickChosenQuote([m19, m16, pac], "motoboy 19h-21h", undefined));
    out["amanhã"] = k(pickChosenQuote([m19, m9am, pac], "amanhã", undefined));
    out["pague até 13h"] = k(pickChosenQuote([m19, m16, pac], "pague até 13h", undefined));
    out["13h (cutoff do 19h)"] = k(pickChosenQuote([m19, m16, pac], "13h", undefined));
    out["sedex / [SEDEX, SEDEX 10]"] = k(pickChosenQuote([sedex, { ...sedex, rateId: "r-s10", optionKey: "r-s10", name: "SEDEX 10" }], "sedex", undefined));
    out["old chosenRateId vs new optionKey correios"] = k(pickChosenQuote([pac, sedex], undefined, "r-pac"));
    out["old chosenRateId 'r-moto' vs motoboy keys"] = k(pickChosenQuote([m19, pac], undefined, "r-moto"));
    out["2 / lista de 1"] = k(pickChosenQuote([m19], "2", undefined));
    out["0"] = k(pickChosenQuote([m19, pac], "0", undefined));
    out["motoboy das 19 às 21"] = k(pickChosenQuote([m19, m16, pac], "motoboy das 19 às 21", undefined));
    out["opção 2 (19h) — índice vs hora"] = k(pickChosenQuote([m16, m19, pac], "opção 1 (19h)", undefined));
    // confirmQuoteUnchanged: ontem "amanhã 19h" vs hoje "hoje 19h" (mesma chave)
    const yesterdayTomorrow = moto("r-moto", "2026-09-13", "19:00", "21:00", "13:00", "amanhã");
    const c = confirmQuoteUnchanged(yesterdayTomorrow, [m19, pac], "01310100");
    out["confirm ontem-amanhã == hoje-hoje"] = c.ok ? `ok:${c.quote.label}` : c.text;
    const yesterdayToday = moto("r-moto", "2026-09-12", "19:00", "21:00", "13:00", "hoje");
    const c2 = confirmQuoteUnchanged(yesterdayToday, [m19, pac], "01310100");
    out["confirm ontem-hoje vs hoje"] = c2.ok ? `ok:${c2.quote.label}` : c2.text;
    require("node:fs").writeFileSync("/private/tmp/claude-501/-Users-fabiano-TRIV-/20560e3d-97e5-4ebf-9f52-dfaf7ef88d80/scratchpad/pick.json", JSON.stringify(out, null, 2));
    expect(true).toBe(true);
  });
});
