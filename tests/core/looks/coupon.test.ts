import { describe, expect, it } from "vitest";

import { distancesToProductPhotos, lookCouponCaptionLine, lookCouponDedupeKey, lookCouponEligibility, lookCouponRefusalHint, lookCouponToolHint, looksLikeCatalogPhoto } from "@/core/looks/coupon";

const sp = (iso: string) => new Date(`${iso}-03:00`);

describe("lookCouponEligibility", () => {
  const ok = { enabled: true, customerId: "c1", deliveredOrderId: "o1", catalogDistances: [20, 31] };
  it("na ordem: desligado, sem cadastro, sem compra entregue, print do catálogo", () => {
    expect(lookCouponEligibility(ok)).toEqual({ ok: true });
    expect(lookCouponEligibility({ ...ok, enabled: false })).toEqual({ ok: false, reason: "desligado" });
    expect(lookCouponEligibility({ ...ok, customerId: null })).toEqual({ ok: false, reason: "sem_cadastro" });
    expect(lookCouponEligibility({ ...ok, deliveredOrderId: null })).toEqual({ ok: false, reason: "sem_compra_entregue" });
    expect(lookCouponEligibility({ ...ok, catalogDistances: [8] })).toEqual({ ok: false, reason: "foto_de_catalogo" });
    expect(lookCouponEligibility({ ...ok, catalogDistances: [9] })).toEqual({ ok: true });
    // Sem hash (reconhecimento desligado): a compra entregue já é o filtro forte.
    expect(lookCouponEligibility({ ...ok, catalogDistances: null })).toEqual({ ok: true });
  });
});

describe("textos", () => {
  it("dedupe, legenda, dica e silêncio", () => {
    expect(lookCouponDedupeKey("c1", "p1")).toBe("look_photo:c1:p1");
    expect(lookCouponCaptionLine({ code: "MARIA-K7X2M", percent: 10, expiresAt: sp("2026-11-19T23:59:59") })).toBe("Seu mimo: cupom MARIA-K7X2M (10% até 19/11) 🤎");
    expect(lookCouponToolHint({ code: "MARIA-K7X2M", percent: 10, expiresAt: sp("2026-11-19T23:59:59"), created: true })).toContain("Ela ganhou o cupom MARIA-K7X2M (10% até 19/11)");
    expect(lookCouponToolHint({ code: "MARIA-K7X2M", percent: 10, expiresAt: sp("2026-11-19T23:59:59"), created: false })).toBe("Ela já tinha ganhado o cupom MARIA-K7X2M por essa peça: não prometa outro.");
    expect(lookCouponRefusalHint("foto_de_catalogo")).toContain("sem cupom");
    expect(lookCouponRefusalHint("sem_compra_entregue")).toBeNull();
  });
});

describe("anti-print", () => {
  it("distâncias às fotos da peça (hashes tortos ignorados) e o limiar de 'é o catálogo'", () => {
    expect(distancesToProductPhotos("0000000000000000", ["0000000000000001", "ffffffffffffffff", null, "zz"])).toEqual([1, 64]);
    expect(distancesToProductPhotos("zz", ["0000000000000000"])).toBeNull();
    expect(looksLikeCatalogPhoto([9, 30])).toBe(false);
    expect(looksLikeCatalogPhoto([8, 30])).toBe(true);
    expect(looksLikeCatalogPhoto(null)).toBe(false);
    expect(looksLikeCatalogPhoto([])).toBe(false);
  });
});
