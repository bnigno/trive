// Crédito dela (troca, proteção de preço): uso único, a sobra se perde e só
// entra no pedido com o SIM dela (caso do #1030).
import { describe, expect, it } from "vitest";

import { creditConsent, creditLeftoverCents, isStoreCredit, storeCreditLabel, storeCreditMemoryLine } from "@/core/coupons/credit";
import { formatCentsBRL } from "@/lib/money";

const NOW = new Date("2026-10-12T15:00:00Z");

describe("isStoreCredit", () => {
  it("troca e proteção de preço são crédito; os demais cupons não", () => {
    expect(isStoreCredit("troca")).toBe(true);
    expect(isStoreCredit("price_protection")).toBe(true);
    for (const origin of ["manual", "paper_voucher", "lia_gift", "referral", "referral_reward", "provador_welcome", "late_delivery", "look_photo"]) {
      expect(isStoreCredit(origin)).toBe(false);
    }
    expect(isStoreCredit(null)).toBe(false);
    expect(isStoreCredit(undefined)).toBe(false);
  });
});

describe("creditLeftoverCents", () => {
  it("o que sobra do crédito depois do desconto (nunca negativo)", () => {
    expect(creditLeftoverCents(4950, 2999)).toBe(1951);
    expect(creditLeftoverCents(4950, 4950)).toBe(0);
    expect(creditLeftoverCents(4950, 6000)).toBe(0);
  });
});

describe("storeCreditMemoryLine", () => {
  it("lista o crédito ativo com valor e validade e manda perguntar antes de usar", () => {
    const line = storeCreditMemoryLine([{ code: "SABRINA-HN5U7", valueCents: 4950, expiresAt: new Date("2026-12-31T02:59:59Z") }], NOW);
    expect(line).toBe(
      `Crédito dela: SABRINA-HN5U7 — ${formatCentsBRL(4950)}, vale até 30/12 (uso único; o que passar da compra se perde). Só entra no pedido com o SIM dela: ao fechar, pergunte se quer usar agora.`,
    );
  });

  it("vencido ou zerado fica de fora; nenhum = null; sem validade não mostra data", () => {
    expect(storeCreditMemoryLine([{ code: "VELHO", valueCents: 1000, expiresAt: new Date("2026-10-01T00:00:00Z") }], NOW)).toBeNull();
    expect(storeCreditMemoryLine([{ code: "ZERO", valueCents: 0, expiresAt: null }], NOW)).toBeNull();
    expect(storeCreditMemoryLine([], NOW)).toBeNull();
    expect(storeCreditMemoryLine([{ code: "SEMPRE", valueCents: 2000, expiresAt: null }], NOW)).toContain(`SEMPRE — ${formatCentsBRL(2000)} (uso único`);
  });
});

describe("storeCreditLabel", () => {
  it("diz de onde veio o crédito (a Lia não fala em troca para quem não devolveu nada)", () => {
    expect(storeCreditLabel("troca")).toBe("crédito de troca (peça devolvida)");
    expect(storeCreditLabel("price_protection")).toContain("proteção de preço");
  });
});

describe("creditConsent — o crédito só entra com o SIM dela, depois de ela responder à pergunta", () => {
  const asked = { code: "SABRINA-HN5U7", askedInbound: "msg-1" };

  it("cupom omitido com crédito validado: perguntar (nunca entra sozinho); sem crédito: segue", () => {
    expect(creditConsent({ explicitCode: undefined, explicitIsCredit: false, validatedCredit: asked, questionAnswered: true })).toEqual({ ok: false, reason: "omitted" });
    expect(creditConsent({ explicitCode: undefined, explicitIsCredit: false, validatedCredit: null, questionAnswered: true })).toEqual({ ok: true });
  });

  it("cupom vazio (ela disse não) ou cupom que não é crédito: segue", () => {
    expect(creditConsent({ explicitCode: "", explicitIsCredit: false, validatedCredit: asked, questionAnswered: false })).toEqual({ ok: true });
    expect(creditConsent({ explicitCode: "DEZ10", explicitIsCredit: false, validatedCredit: asked, questionAnswered: false })).toEqual({ ok: true });
  });

  it("código do crédito sem a resposta dela (mesmo turno, iniciativa, mensagem de antes da pergunta): espere; respondida: vale", () => {
    expect(creditConsent({ explicitCode: "SABRINA-HN5U7", explicitIsCredit: true, validatedCredit: asked, questionAnswered: false })).toEqual({ ok: false, reason: "same_turn" });
    expect(creditConsent({ explicitCode: " sabrina-hn5u7 ", explicitIsCredit: true, validatedCredit: asked, questionAnswered: true })).toEqual({ ok: true });
  });

  it("código de crédito que não passou pela pergunta (sem validar, outro código, pergunta sem registro): recusa", () => {
    expect(creditConsent({ explicitCode: "SABRINA-HN5U7", explicitIsCredit: true, validatedCredit: null, questionAnswered: true })).toEqual({ ok: false, reason: "not_asked" });
    expect(creditConsent({ explicitCode: "OUTRO-CRED", explicitIsCredit: true, validatedCredit: asked, questionAnswered: true })).toEqual({ ok: false, reason: "not_asked" });
    expect(creditConsent({ explicitCode: "SABRINA-HN5U7", explicitIsCredit: true, validatedCredit: { code: "SABRINA-HN5U7", askedInbound: null }, questionAnswered: true })).toEqual({ ok: false, reason: "not_asked" });
  });
});
