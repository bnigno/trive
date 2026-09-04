import { describe, expect, it } from "vitest";

import { settingText } from "@/lib/settings-text";

describe("settingText", () => {
  it("devolve o texto sem espaços nas pontas", () => {
    expect(settingText({ store_name: "  TRIVÉ " }, "store_name")).toBe("TRIVÉ");
  });

  it("cai no fallback quando falta, está vazio ou não é texto", () => {
    expect(settingText({}, "store_cnpj")).toBe("");
    expect(settingText({ store_cnpj: "   " }, "store_cnpj", "a maison")).toBe("a maison");
    expect(settingText({ store_cnpj: 12 }, "store_cnpj", "x")).toBe("x");
  });
});
