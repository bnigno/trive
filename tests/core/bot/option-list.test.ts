// Limites da lista tocável e a mensagem do catálogo em várias listas (puro).
import { describe, expect, it } from "vitest";

import { CATALOG_MAX_LISTS_PER_CALL, CATALOG_RESEND_GUARD_MS, catalogListMessage, OPTION_LIST_MAX_OPTIONS, truncateOptionTitle } from "@/core/bot/option-list";

describe("catalogListMessage", () => {
  it("sem faixa quando tudo cabe numa lista; com a faixa quando o catálogo vai em várias", () => {
    expect(catalogListMessage(1, 7, 7)).toBe("Toque abaixo e veja o catálogo 👇");
    expect(catalogListMessage(1, 10, 10)).toBe("Toque abaixo e veja o catálogo 👇");
    expect(catalogListMessage(1, 10, 25)).toBe("Toque abaixo e veja o catálogo 👇 (1–10 de 25)");
    expect(catalogListMessage(21, 25, 25)).toBe("Toque abaixo e veja o catálogo 👇 (21–25 de 25)");
  });

  it("tetos: 10 por lista, 3 listas por chamada (30 peças), guarda de 30 min", () => {
    expect(OPTION_LIST_MAX_OPTIONS).toBe(10);
    expect(CATALOG_MAX_LISTS_PER_CALL).toBe(3);
    expect(CATALOG_RESEND_GUARD_MS).toBe(30 * 60 * 1000);
    expect(truncateOptionTitle("Vestido Longo Dunas em Linho Natural")).toBe("Vestido Longo Dunas em…");
  });
});
