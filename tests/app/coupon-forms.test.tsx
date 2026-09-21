// Os forms do painel de cupons, renderizados com react-dom/server: os nomes
// dos campos são o contrato com as actions (readRuleFields) e os defaults do
// editar têm de voltar para os inputs.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CouponCreateForm,
  CouponDeleteForm,
  CouponEditForm,
  EMPTY_COUPON_DEFAULTS,
  type CouponFormDefaults,
} from "@/app/admin/(protected)/cupons/forms";

const CATEGORIES = [
  { id: "11111111-1111-4111-8111-111111111111", name: "Blusas" },
  { id: "22222222-2222-4222-8222-222222222222", name: "Vestidos" },
];

const RULE_FIELD_NAMES = [
  "type",
  "value",
  "minOrder",
  "maxUses",
  "startsAt",
  "expiresAt",
  "perCustomerLimit",
  "customerPhone",
  "firstPurchaseOnly",
  "productRefs",
  "categoryIds",
  "weekdays",
  "validFrom",
  "validTo",
  "note",
];

describe("CouponCreateForm", () => {
  it("tem todos os campos que readRuleFields lê, o código e os três tipos", () => {
    const html = renderToStaticMarkup(<CouponCreateForm categories={CATEGORIES} />);
    expect(html).toContain('name="code"');
    for (const name of RULE_FIELD_NAMES) expect(html, name).toContain(`name="${name}"`);
    expect(html).toContain('value="free_shipping"');
    expect(html).toContain("Blusas");
    expect(html).toContain("chuva das duas");
    // Sete dias da semana, um checkbox cada.
    expect(html.match(/name="weekdays"/g)).toHaveLength(7);
  });
});

describe("CouponEditForm", () => {
  const defaults: CouponFormDefaults = {
    ...EMPTY_COUPON_DEFAULTS,
    type: "fixed",
    value: "24,90",
    minOrder: "150,00",
    expiresAt: "2026-10-20T23:59",
    maxUses: "100",
    perCustomerLimit: "1",
    customerPhone: "+5591999990000",
    firstPurchaseOnly: true,
    weekdays: [0, 6],
    validFrom: "14:00",
    validTo: "15:00",
    productRefs: "LONGO-DUNAS\nblusa-maelle",
    categoryIds: [CATEGORIES[1].id],
    note: "story de sábado",
  };

  it("sem uso: form completo, com os defaults nos inputs e as regras abertas", () => {
    const html = renderToStaticMarkup(<CouponEditForm couponId="cpn-1" defaults={defaults} categories={CATEGORIES} locked={false} />);
    expect(html).toContain('name="mode" value="full"');
    expect(html).toContain('value="24,90"');
    expect(html).toContain('value="150,00"');
    expect(html).toContain('value="2026-10-20T23:59"');
    expect(html).toContain('value="+5591999990000"');
    expect(html).toContain('value="14:00"');
    expect(html).toContain('value="15:00"');
    expect(html).toContain("LONGO-DUNAS\nblusa-maelle");
    expect(html).toContain('value="story de sábado"');
    expect(html).toContain("<details");
    expect(html).toContain(" open");
    // Vestidos marcado, Blusas não; sábado e domingo marcados.
    expect(html).toContain(`name="categoryIds" checked="" value="${CATEGORIES[1].id}"`);
    expect(html).toContain(`name="categoryIds" value="${CATEGORIES[0].id}"`);
    expect(html.match(/name="weekdays" checked="" value="\d"/g)).toHaveLength(2);
    expect(html).toContain('name="firstPurchaseOnly" checked=""');
  });

  it("já usado: só vigência, limite de usos e nota", () => {
    const html = renderToStaticMarkup(<CouponEditForm couponId="cpn-1" defaults={defaults} categories={CATEGORIES} locked />);
    expect(html).toContain('name="mode" value="limited"');
    expect(html).toContain('name="expiresAt"');
    expect(html).toContain('name="maxUses"');
    expect(html).toContain('name="note"');
    expect(html).not.toContain('name="value"');
    expect(html).not.toContain('name="productRefs"');
  });
});

describe("CouponDeleteForm", () => {
  it("manda o id e pede confirmação", () => {
    const html = renderToStaticMarkup(<CouponDeleteForm couponId="cpn-1" code="CHUVA" />);
    expect(html).toContain('name="id" value="cpn-1"');
    expect(html).toContain("Excluir");
  });
});
