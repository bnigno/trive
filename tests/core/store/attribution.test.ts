import { describe, expect, it } from "vitest";

import { attributionFrom, attributionLabel, ORIGIN_MAX_AGE_MS, storedOriginSchema } from "@/core/store/attribution";

const NOW = new Date("2026-10-05T15:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

describe("attributionFrom", () => {
  it("link de story tocado há 2 dias vale, com o slug minúsculo", () => {
    expect(attributionFrom({ kind: "campaign", ref: "Dunas-Story", at: ago(2 * 24 * 3600_000) }, NOW)).toEqual({
      kind: "campaign",
      ref: "dunas-story",
      touchedAt: ago(2 * 24 * 3600_000),
    });
  });

  it("cupom vira maiúsculo", () => {
    expect(attributionFrom({ kind: "coupon", ref: "amiga7k", at: ago(60_000) }, NOW)?.ref).toBe("AMIGA7K");
  });

  it("vale até 7 dias e nem um minuto a mais", () => {
    expect(attributionFrom({ kind: "campaign", ref: "dunas", at: ago(ORIGIN_MAX_AGE_MS) }, NOW)).not.toBeNull();
    expect(attributionFrom({ kind: "campaign", ref: "dunas", at: ago(ORIGIN_MAX_AGE_MS + 60_000) }, NOW)).toBeNull();
  });

  it("relógio do celular um pouco adiantado passa, com o instante limitado a agora; muito adiantado não", () => {
    const early = attributionFrom({ kind: "campaign", ref: "dunas", at: ago(-5 * 60_000) }, NOW);
    expect(early?.touchedAt).toBe(NOW.toISOString());
    expect(attributionFrom({ kind: "campaign", ref: "dunas", at: ago(-60 * 60_000) }, NOW)).toBeNull();
  });

  it("referência fora do formato do slug ou do código é descartada", () => {
    expect(attributionFrom({ kind: "campaign", ref: "dunas story!", at: ago(0) }, NOW)).toBeNull();
    expect(attributionFrom({ kind: "coupon", ref: "-AMIGA", at: ago(0) }, NOW)).toBeNull();
  });

  it("sem origem = null", () => {
    expect(attributionFrom(undefined, NOW)).toBeNull();
    expect(attributionFrom(null, NOW)).toBeNull();
  });
});

describe("storedOriginSchema", () => {
  it("recusa tipo desconhecido e data que não é ISO", () => {
    expect(storedOriginSchema.safeParse({ kind: "facebook", ref: "x1", at: ago(0) }).success).toBe(false);
    expect(storedOriginSchema.safeParse({ kind: "campaign", ref: "dunas", at: "ontem" }).success).toBe(false);
  });
});

describe("attributionLabel", () => {
  it("mostra o link ou o cupom", () => {
    expect(attributionLabel({ kind: "campaign", ref: "dunas" })).toBe("/ig/dunas");
    expect(attributionLabel({ kind: "coupon", ref: "AMIGA7K" })).toBe("cupom AMIGA7K");
  });
});
