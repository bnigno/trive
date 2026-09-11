import { describe, expect, it } from "vitest";

import {
  careNotesToLabels,
  CARE_SYMBOL_KEYS,
  formatCareNotes,
  parseCareNotes,
} from "@/core/catalog/care";

describe("cuidados com a peça", () => {
  it("chave por linha vira pictograma; o resto fica como texto, na ordem e sem repetir", () => {
    const notes = parseCareNotes("hand_wash\nNão torcer\ndry_shade\nhand_wash\nNão torcer\n\n");
    expect(notes).toEqual({ symbols: ["hand_wash", "dry_shade"], freeText: ["Não torcer"] });
  });

  it("o rótulo escrito por extenso também vira pictograma (sem caixa nem acento)", () => {
    expect(parseCareNotes("LAVAR A MAO\nsecar à sombra").symbols).toEqual(["hand_wash", "dry_shade"]);
  });

  it("formatCareNotes é o inverso do parse e ordena as chaves na ordem canônica", () => {
    const text = formatCareNotes(["dry_shade", "hand_wash", "desconhecida"], ["Não torcer", " "]);
    expect(text).toBe("hand_wash\ndry_shade\nNão torcer");
    expect(parseCareNotes(text)).toEqual({ symbols: ["hand_wash", "dry_shade"], freeText: ["Não torcer"] });
    expect(formatCareNotes([], [])).toBeNull();
  });

  it("rótulos legíveis para a Lia e para a impressão", () => {
    expect(careNotesToLabels(parseCareNotes("no_iron\nUsar cabide largo"))).toEqual([
      "Não passar",
      "Usar cabide largo",
    ]);
    expect(CARE_SYMBOL_KEYS).toHaveLength(8);
  });
});
