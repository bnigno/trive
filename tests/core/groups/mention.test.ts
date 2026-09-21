import { describe, expect, it } from "vitest";

import { groupSignalMemoryLines, isSoPrivadoCommand, renderMentionReplyBody, renderMentionUserMessage } from "@/core/groups/mention";

describe("só privado", () => {
  it("reconhece as formas comuns; frases maiores não", () => {
    for (const text of ["só privado", "SO PRIVADO", "Só privado.", "somente privado", "apenas no privado", "só pelo privado!", "  só o privado "]) {
      expect(isSoPrivadoCommand(text), text).toBe(true);
    }
    for (const text of ["quero só privado por favor", "privado", "só", "SAIR", "me tira do grupo"]) {
      expect(isSoPrivadoCommand(text), text).toBe(false);
    }
  });
});

describe("menção", () => {
  it("mensagem sintética diz quem e onde; resposta leva @número quando há telefone", () => {
    expect(renderMentionUserMessage({ groupName: "Provador TRIVÉ", senderName: " Ana ", text: " @Lia tem em M? " })).toBe(
      '[No grupo "Provador TRIVÉ", Ana chamou você:] @Lia tem em M?',
    );
    expect(renderMentionUserMessage({ groupName: "Provador TRIVÉ", senderName: null, text: "oi" })).toBe('[No grupo "Provador TRIVÉ", uma membra chamou você:] oi');
    expect(renderMentionReplyBody({ reply: " Tem sim: 2 em M. ", participantPhoneDigits: "5591999991528" })).toBe("@5591999991528 Tem sim: 2 em M.");
    expect(renderMentionReplyBody({ reply: "Tem sim.", participantPhoneDigits: null })).toBe("Tem sim.");
  });
});

describe("linhas do Provador no caderninho", () => {
  const tue = new Date("2026-09-22T13:00:00Z");
  const thu = new Date("2026-09-24T22:00:00Z");
  it("voto, reação (com as peças) e menção, mais recentes primeiro, no máximo 3; retirados não entram", () => {
    const lines = groupSignalMemoryLines([
      { kind: "poll_vote", value: '["Verde"]', createdAt: new Date("2026-09-24T23:00:00Z"), postKind: "enquete", postAt: thu, productNames: [] },
      { kind: "reaction", value: "❤️", createdAt: new Date("2026-09-22T14:00:00Z"), postKind: "chegadas", postAt: tue, productNames: ["Vestido Terracota", "Calça Areia"] },
      { kind: "mention", value: "  @Lia tem   em M? ", createdAt: new Date("2026-09-22T15:00:00Z"), postKind: null, postAt: null, productNames: [] },
      { kind: "reaction", value: "", createdAt: new Date("2026-09-23T14:00:00Z"), postKind: "chegadas", postAt: tue, productNames: [] },
      { kind: "poll_vote", value: "", createdAt: new Date("2026-09-25T14:00:00Z"), postKind: "enquete", postAt: thu, productNames: [] },
      { kind: "message", value: "", createdAt: new Date("2026-09-26T14:00:00Z"), postKind: null, postAt: null, productNames: [] },
      { kind: "reaction", value: "👏", createdAt: new Date("2026-09-19T14:00:00Z"), postKind: "livre", postAt: new Date("2026-09-19T13:00:00Z"), productNames: [] },
    ]);
    expect(lines).toEqual([
      "Provador: votou «Verde» na enquete de quinta 24/09",
      "Provador: chamou você no grupo (terça 22/09): «@Lia tem em M?»",
      "Provador: reagiu ❤️ ao Passou pelo Provador de terça 22/09 (Vestido Terracota, Calça Areia)",
    ]);
    expect(groupSignalMemoryLines([])).toEqual([]);
  });
});
