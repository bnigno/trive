// A recusa em português. Em 09–10/2026 sete cartões foram recusados pelo site
// e o motivo era descartado antes de chegar ao banco — o dono só descobriu
// pela cliente reclamando.
import { describe, expect, it } from "vitest";

import { explainRejection } from "@/core/orders/payment-rejection";

describe("explainRejection", () => {
  it("explica o motivo real das 7 recusas da loja", () => {
    const r = explainRejection("cc_rejected_high_risk");
    expect(r.motivo).toBe("O antifraude do Mercado Pago recusou por segurança.");
    expect(r.acao).toContain("Pix");
    // Tentar o mesmo cartão de novo não resolve: foi o que a cliente fez 6 vezes.
    expect(r.adiantaTentarDeNovo).toBe(false);
  });

  it("separa o que adianta tentar de novo do que não adianta", () => {
    expect(explainRejection("cc_rejected_bad_filled_security_code").adiantaTentarDeNovo).toBe(true);
    expect(explainRejection("cc_rejected_bad_filled_date").adiantaTentarDeNovo).toBe(true);
    expect(explainRejection("cc_rejected_insufficient_amount").adiantaTentarDeNovo).toBe(false);
    expect(explainRejection("cc_rejected_card_disabled").adiantaTentarDeNovo).toBe(false);
  });

  it("nunca responde em inglês nem com código cru nos motivos conhecidos", () => {
    for (const codigo of [
      "cc_rejected_high_risk",
      "cc_rejected_insufficient_amount",
      "cc_rejected_bad_filled_security_code",
      "cc_rejected_call_for_authorize",
      "cc_rejected_duplicated_payment",
      "cc_rejected_max_attempts",
    ]) {
      const { motivo } = explainRejection(codigo);
      expect(motivo).not.toContain("cc_rejected");
      expect(motivo).not.toMatch(/[a-z]_[a-z]/);
    }
  });

  it("motivo novo do MP não vira silêncio: mostra o código para pesquisar", () => {
    const r = explainRejection("cc_rejected_invente_um");
    expect(r.motivo).toContain("cc_rejected_invente_um");
    expect(r.acao).toContain("Pix");
  });

  it("sem motivo nenhum, ainda diz algo útil", () => {
    const r = explainRejection(null);
    expect(r.motivo).toContain("não informou o motivo");
    expect(r.acao).toContain("Pix");
  });
});
