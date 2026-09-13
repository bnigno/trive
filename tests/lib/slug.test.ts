import { describe, expect, it } from "vitest";

import { slugify } from "@/lib/slug";

describe("slugify", () => {
  it("sem acento, minúsculo, hífens únicos nas pontas cortados; vazio quando não sobra nada", () => {
    expect(slugify("Vestido Dunas — Areia")).toBe("vestido-dunas-areia");
    expect(slugify("  Círio 2026  ")).toBe("cirio-2026");
    expect(slugify("!!!")).toBe("");
    expect(slugify("")).toBe("");
  });
});
