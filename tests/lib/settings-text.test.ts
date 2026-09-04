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

describe("describeContact", () => {
  it("monta a frase só com os canais preenchidos", async () => {
    const { describeContact } = await import("@/lib/settings-text");
    expect(describeContact("(11) 99999-0000", "oi@maison.com")).toBe(
      "pelo WhatsApp ((11) 99999-0000) ou pelo e-mail (oi@maison.com)",
    );
    expect(describeContact("(11) 99999-0000", "")).toBe("pelo WhatsApp ((11) 99999-0000)");
    expect(describeContact("", "oi@maison.com")).toBe("pelo e-mail (oi@maison.com)");
    expect(describeContact("", "")).toBe("pelos nossos canais de atendimento");
  });
});
