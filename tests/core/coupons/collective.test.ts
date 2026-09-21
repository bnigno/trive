import { describe, expect, it } from "vitest";

import { collectiveAdminLabel, collectiveCustomerHint, collectiveShareText, collectiveValue, isCollective, type CollectiveCoupon } from "@/core/coupons/collective";
import { formatCentsBRL } from "@/lib/money";

const turma: CollectiveCoupon = { type: "percent", value: 5, growthPerRedeemer: 2, growthCap: 15 };

describe("collectiveValue", () => {
  it("sobe por amiga até o teto; cupom comum não muda", () => {
    expect([0, 1, 2, 5, 50].map((n) => collectiveValue(turma, n))).toEqual([5, 7, 9, 15, 15]);
    expect(collectiveValue({ ...turma, growthCap: 5 }, 3)).toBe(5);
    expect(collectiveValue({ ...turma, growthPerRedeemer: 0 }, 9)).toBe(5);
    expect(isCollective(turma)).toBe(true);
    expect(isCollective({ growthPerRedeemer: 0 })).toBe(false);
  });
});

describe("textos", () => {
  it("painel", () => {
    expect(collectiveAdminLabel(turma, 2)).toBe("5% + 2 pontos por amiga (teto 15%) · 2 amigas · vale 9% agora");
    expect(collectiveAdminLabel(turma, 1)).toBe("5% + 2 pontos por amiga (teto 15%) · 1 amiga · vale 7% agora");
    expect(collectiveAdminLabel({ ...turma, growthPerRedeemer: 0 }, 2)).toBeNull();
  });

  it("cliente: primeira, algumas, teto, em reais", () => {
    expect(collectiveCustomerHint(turma, 0)).toBe("Cupom da turma: 5% hoje — você pode ser a primeira. Cada nova amiga sobe 2 pontos, até 15%.");
    expect(collectiveCustomerHint(turma, 1)).toBe("Cupom da turma: 7% hoje — 1 amiga já usou. Cada nova amiga sobe 2 pontos, até 15%.");
    expect(collectiveCustomerHint(turma, 2)).toBe("Cupom da turma: 9% hoje — 2 amigas já usaram. Cada nova amiga sobe 2 pontos, até 15%.");
    expect(collectiveCustomerHint(turma, 7)).toBe("Cupom da turma: 15% hoje — a turma chegou ao teto (7 amigas).");
    const reais: CollectiveCoupon = { type: "fixed", value: 1000, growthPerRedeemer: 500, growthCap: 3000 };
    expect(collectiveCustomerHint(reais, 1)).toBe(`Cupom da turma: ${formatCentsBRL(1500)} hoje — 1 amiga já usou. Cada nova amiga sobe ${formatCentsBRL(500)}, até ${formatCentsBRL(3000)}.`);
  });

  it("texto para a amiga com o link que aplica o cupom", () => {
    expect(collectiveShareText({ code: "TURMA10", currentValueLabel: "9%", storeName: "TRIVÉ", siteUrl: "https://www.trivemaison.com.br" })).toBe(
      "Tô usando o cupom TURMA10 na TRIVÉ: quanto mais amigas usam, maior o desconto pra todo mundo. Hoje tá em 9%. Pega o seu: https://www.trivemaison.com.br/c/TURMA10",
    );
  });
});
