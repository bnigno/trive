import { describe, expect, it } from "vitest";

import { voucherFingerprint, voucherPlan, voucherQrText, voucherTexts, type VoucherCardData } from "@/core/edition/voucher";

const base: VoucherCardData = {
  kind: "para_voce",
  code: "MARIA-K7X2M",
  percent: 10,
  expiresLabel: "até 20/11",
  firstName: "Maria",
  storeName: "TRIVÉ",
  editionName: null,
  qrUrl: "https://wa.me/5591999990000?text=Oi",
};

describe("voucherPlan", () => {
  it("dois vales; presente só o da amiga; desligado ou sem WhatsApp nenhum", () => {
    expect(voucherPlan({ enabled: true, isGift: false, hasStoreWhatsapp: true })).toEqual(["para_voce", "para_uma_amiga"]);
    expect(voucherPlan({ enabled: true, isGift: true, hasStoreWhatsapp: true })).toEqual(["para_uma_amiga"]);
    expect(voucherPlan({ enabled: false, isGift: false, hasStoreWhatsapp: true })).toEqual([]);
    expect(voucherPlan({ enabled: true, isGift: false, hasStoreWhatsapp: false })).toEqual([]);
  });
});

describe("textos e QR", () => {
  it("para você / para uma amiga", () => {
    expect(voucherTexts(base)).toEqual({
      eyebrow: "VALE 10% · PARA VOCÊ",
      headline: "Maria, este é seu",
      body: "10% na sua próxima peça da TRIVÉ, até 20/11.",
      invite: "Aponte a câmera e diga o código por aqui — ou use no site.",
    });
    expect(voucherTexts({ ...base, kind: "para_uma_amiga", percent: 15 })).toMatchObject({
      eyebrow: "VALE 15% · PARA UMA AMIGA",
      headline: "Uma amiga sua vai gostar",
      body: "15% na primeira compra dela na TRIVÉ, até 20/11. Quando ela usar, você ganha um mimo também.",
    });
    expect(voucherQrText("Lia", "AMIGA-K7X2M")).toBe("Oi, Lia! Tenho o vale AMIGA-K7X2M");
  });

  it("impressão digital muda com o que entra no desenho", () => {
    expect(voucherFingerprint(base)).toBe(voucherFingerprint({ ...base }));
    expect(voucherFingerprint(base)).not.toBe(voucherFingerprint({ ...base, percent: 15 }));
    expect(voucherFingerprint(base)).not.toBe(voucherFingerprint({ ...base, code: "OUTRO" }));
  });
});
