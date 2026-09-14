import { describe, expect, it } from "vitest";

import {
  ATELIER_HELP_REASONS,
  atelierDraftVars,
  atelierHelpReasonText,
  isAtelierHelpReason,
  photosLabel,
} from "@/core/atelier/reply";

describe("resposta do Ateliê", () => {
  it("conta as fotos em português", () => {
    expect(photosLabel(1)).toBe("1 foto");
    expect(photosLabel(3)).toBe("3 fotos");
  });

  it("monta as variáveis do template owner_atelier_draft", () => {
    expect(atelierDraftVars({ name: "Longo Dunas", photos: 2, link: "https://x/admin/produtos/1" })).toEqual({
      peca: "Longo Dunas",
      fotos: "2 fotos",
      link: "https://x/admin/produtos/1",
    });
  });

  it("todo motivo de ajuda tem texto e é reconhecido pelo guard", () => {
    for (const reason of Object.keys(ATELIER_HELP_REASONS)) {
      expect(isAtelierHelpReason(reason)).toBe(true);
      expect(atelierHelpReasonText(reason as keyof typeof ATELIER_HELP_REASONS).length).toBeGreaterThan(10);
    }
    expect(isAtelierHelpReason("qualquer")).toBe(false);
    expect(atelierHelpReasonText("documento")).toContain("documento");
  });
});
