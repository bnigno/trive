import { describe, expect, it } from "vitest";

import {
  canSchedule,
  dropPhase,
  rankAudience,
  scoreDropAffinity,
  vipStartsAt,
  type AudienceCandidate,
  type DropAffinityProduct,
} from "@/core/drops";
import { EMPTY_PROFILE, mergeStyleProfile } from "@/core/style/profile";

const publishAt = new Date("2026-09-20T13:00:00Z");

describe("fases do lançamento", () => {
  it("vipStartsAt e dropPhase seguem a janela", () => {
    expect(vipStartsAt(publishAt, 24).toISOString()).toBe("2026-09-19T13:00:00.000Z");
    const drop = { status: "scheduled", publishAt, vipWindowHours: 24 };
    expect(dropPhase(drop, new Date("2026-09-18T13:00:00Z"))).toBe("scheduled");
    expect(dropPhase(drop, new Date("2026-09-19T13:00:00Z"))).toBe("vip");
    expect(dropPhase(drop, new Date("2026-09-20T13:00:00Z"))).toBe("published");
    expect(dropPhase({ ...drop, status: "vip_sent" }, new Date("2026-09-19T20:00:00Z"))).toBe("vip");
    expect(dropPhase({ ...drop, status: "draft" }, new Date("2026-09-19T20:00:00Z"))).toBe("draft");
    expect(dropPhase({ ...drop, status: "canceled" }, new Date("2026-09-25T00:00:00Z"))).toBe("canceled");
    expect(dropPhase({ ...drop, status: "published" }, new Date("2026-09-19T00:00:00Z"))).toBe("published");
  });

  it("canSchedule lista os problemas", () => {
    const now = new Date("2026-09-18T12:00:00Z");
    const ok = { id: "a", name: "Vestido", status: "draft", hasActivePrice: true, hasStock: true, hasPhoto: true };
    expect(canSchedule({ publishAt, vipWindowHours: 24, products: [ok] }, now)).toEqual({ ok: true, problems: [] });
    const result = canSchedule(
      {
        publishAt: new Date("2026-09-18T20:00:00Z"),
        vipWindowHours: 24,
        products: [{ ...ok, hasPhoto: false, hasStock: false }],
      },
      now,
    );
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      "A janela VIP já teria começado — escolha uma data mais à frente ou uma janela menor.",
      "Vestido: sem estoque.",
      "Vestido: sem foto.",
    ]);
    expect(canSchedule({ publishAt, vipWindowHours: 24, products: [] }, now).problems).toEqual(["Escolha ao menos uma peça."]);
    expect(canSchedule({ publishAt: new Date("2026-09-10T00:00:00Z"), vipWindowHours: 24, products: [ok] }, now).problems[0]).toBe(
      "A data de publicação já passou.",
    );
  });
});

describe("afinidade e público", () => {
  const products: DropAffinityProduct[] = [
    { id: "p1", name: "Vestido Sol", categoryId: "cat-vest", categoryName: "Vestidos", sizesAvailable: ["M", "G"], colorsAvailable: ["Terracota"] },
    { id: "p2", name: "Blusa Lua", categoryId: "cat-blusa", categoryName: "Blusas", sizesAvailable: ["P"], colorsAvailable: ["Amarelo"] },
  ];
  const candidate = (over: Partial<AudienceCandidate> & { customerId: string }): AudienceCandidate => ({
    phoneE164: "+5511999990000",
    fullName: `Cliente ${over.customerId}`,
    profile: null,
    purchasedCategoryIds: [],
    ...over,
  });

  it("pontua tamanho, cor amada e categoria comprada; a melhor peça vale", () => {
    const ana = candidate({
      customerId: "ana",
      profile: mergeStyleProfile(EMPTY_PROFILE, { sizes: { vestido: "M" }, colorsLove: ["Terracota"] }),
      purchasedCategoryIds: ["cat-vest"],
    });
    expect(scoreDropAffinity(ana, products)).toEqual({ score: 7, reasons: ["tem o M dela", "em Terracota, cor que ela ama", "já comprou Vestidos"] });
    const bia = candidate({ customerId: "bia", profile: mergeStyleProfile(EMPTY_PROFILE, { sizes: { blusa: "P" }, colorsAvoid: ["Amarelo"] }) });
    // Blusa: +3 tamanho −4 cor evitada = −1; Vestido: 0 → melhor 0.
    expect(scoreDropAffinity(bia, products)).toEqual({ score: 0, reasons: [] });
    const carla = candidate({ customerId: "carla", purchasedCategoryIds: ["cat-blusa"] });
    expect(scoreDropAffinity(carla, products)).toEqual({ score: 2, reasons: ["já comprou Blusas"] });
  });

  it("rankAudience filtra por 2 pontos, ordena por afinidade e respeita o limite", () => {
    const ana = candidate({ customerId: "ana", profile: mergeStyleProfile(EMPTY_PROFILE, { sizes: { vestido: "M" }, colorsLove: ["Terracota"] }) });
    const carla = candidate({ customerId: "carla", purchasedCategoryIds: ["cat-blusa"] });
    const dora = candidate({ customerId: "dora" });
    const ranked = rankAudience([dora, carla, ana], products, 5);
    expect(ranked.map((r) => [r.customerId, r.score])).toEqual([["ana", 5], ["carla", 2]]);
    expect(rankAudience([dora, carla, ana], products, 1).map((r) => r.customerId)).toEqual(["ana"]);
  });
});
