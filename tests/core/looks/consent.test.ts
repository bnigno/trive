import { describe, expect, it } from "vitest";

import {
  isLookPublic,
  lookCardTitle,
  lookConsentAckText,
  lookConsentHistoryText,
  lookConsentOptions,
  lookDisplayName,
  lookRowId,
  LOOK_CONSENT_TITLE,
  parseLookRowId,
} from "@/core/looks/consent";

const LOOK = "0b16429e-72de-49d4-bd55-c9d4b87df002";
const NOW = new Date("2026-09-14T12:00:00Z");

describe("Quem já vestiu — consentimento", () => {
  it("ids ≤ 64 e títulos ≤ 24 (limites da Z-API); parse faz a volta; lixo não passa", () => {
    for (const answer of ["sim", "nao"] as const) {
      const id = lookRowId(answer, LOOK);
      expect(id.length).toBeLessThanOrEqual(64);
      expect(parseLookRowId(id)).toEqual({ answer, lookId: LOOK });
    }
    const options = lookConsentOptions(LOOK);
    expect(options).toHaveLength(2);
    for (const option of options) expect(option.title.length).toBeLessThanOrEqual(24);
    expect(LOOK_CONSENT_TITLE.length).toBeLessThanOrEqual(24);
    expect(parseLookRowId("feedback:amei:" + LOOK)).toBeNull();
    expect(parseLookRowId("look:talvez:" + LOOK)).toBeNull();
    expect(parseLookRowId("look:sim:nao-e-uuid")).toBeNull();
    expect(parseLookRowId("look:sim:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBeNull();
    expect(parseLookRowId(`look:sim:${LOOK}:extra`)).toBeNull();
    expect(parseLookRowId(undefined)).toBeNull();
  });

  it("só é pública com o 'sim' dela, a aprovação e sem retirada", () => {
    const base = { consentAnswer: "sim", approvedAt: NOW, rejectedAt: null, revokedAt: null };
    expect(isLookPublic(base)).toBe(true);
    expect(isLookPublic({ ...base, consentAnswer: "nao" })).toBe(false);
    expect(isLookPublic({ ...base, consentAnswer: null })).toBe(false);
    expect(isLookPublic({ ...base, approvedAt: null })).toBe(false);
    expect(isLookPublic({ ...base, revokedAt: NOW })).toBe(false);
    expect(isLookPublic({ ...base, rejectedAt: NOW })).toBe(false);
  });

  it("primeiro nome com inicial maiúscula, no teto do banco; textos do cartão e da conversa", () => {
    expect(lookDisplayName("maria clara souza")).toBe("Maria");
    expect(lookDisplayName("  ANA  ")).toBe("Ana");
    expect(lookDisplayName("")).toBe("Cliente");
    expect(lookDisplayName(null)).toBe("Cliente");
    expect(lookDisplayName("a".repeat(60)).length).toBeLessThanOrEqual(40);
    expect(lookCardTitle("Ana", "Longo Dunas")).toBe("Ana veste Longo Dunas");
    expect(lookConsentHistoryText("sim", "Longo Dunas")).toBe('[resposta a "Posso mostrar na página?" da foto com Longo Dunas]: Sim, pode');
    expect(lookConsentAckText("sim")).toContain("assim que a equipe conferir");
    expect(lookConsentAckText("nao")).toContain("fica só entre nós");
  });
});
