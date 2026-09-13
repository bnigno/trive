// Blocos puros do checkout: escolha padrão da opção de entrega e o ?frete=.
import { describe, expect, it } from "vitest";

import { isWindowOptionKey, parseFreteParam, pickDefaultOptionKey } from "@/lib/checkout-options";

const OPTIONS = [{ optionKey: "m1:2026-09-18:19:00" }, { optionKey: "p1" }];

describe("pickDefaultOptionKey", () => {
  it("mantém a escolha se ela ainda existe; senão a primeira; null sem opções", () => {
    expect(pickDefaultOptionKey(OPTIONS, "p1")).toBe("p1");
    expect(pickDefaultOptionKey(OPTIONS, "m1:2026-09-17:19:00")).toBe("m1:2026-09-18:19:00");
    expect(pickDefaultOptionKey(OPTIONS, null)).toBe("m1:2026-09-18:19:00");
    expect(pickDefaultOptionKey([], "p1")).toBeNull();
  });
});

describe("parseFreteParam", () => {
  it("aceita só o formato da sacola: uuid ou uuid:dia:HH:MM", () => {
    const uuid = "6f1c2a0e-9d3b-4f7a-8c21-0b5e4d2a9f10";
    expect(parseFreteParam(uuid)).toBe(uuid);
    expect(parseFreteParam(` ${uuid}:2026-09-18:19:00 `)).toBe(`${uuid}:2026-09-18:19:00`);
    expect(parseFreteParam(`${uuid}:19:00`)).toBeNull();
    expect(parseFreteParam("PAC")).toBeNull();
    expect(parseFreteParam("")).toBeNull();
    expect(parseFreteParam(undefined)).toBeNull();
  });
});

describe("isWindowOptionKey", () => {
  it("janela do motoboy tem dia e hora na chave; faixa simples não", () => {
    expect(isWindowOptionKey("m1:2026-09-18:19:00")).toBe(true);
    expect(isWindowOptionKey("p1")).toBe(false);
    expect(isWindowOptionKey(null)).toBe(false);
  });
});
