import { describe, expect, it } from "vitest";

import { clampMentionReply, lastUnitNoticeAllowed, MENTION_REPLY_MAX_CHARS, mentionReplyAllowed, shouldTripKillSwitch } from "@/core/groups/health";
import { buildGroupMentionPrompt } from "@/core/groups/mention-prompt";

describe("kill switch", () => {
  it("pausa quando as saídas passam do % e são pelo menos 2; uma saída nunca; 0% desliga", () => {
    expect(shouldTripKillSwitch({ leaves: 3, members: 100, pct: 2 })).toBe(true);
    expect(shouldTripKillSwitch({ leaves: 2, members: 100, pct: 2 })).toBe(false); // 2% não passa de 2%
    expect(shouldTripKillSwitch({ leaves: 2, members: 50, pct: 2 })).toBe(true);
    expect(shouldTripKillSwitch({ leaves: 1, members: 10, pct: 2 })).toBe(false);
    expect(shouldTripKillSwitch({ leaves: 5, members: 100, pct: 0 })).toBe(false);
    expect(shouldTripKillSwitch({ leaves: 5, members: 0, pct: 2 })).toBe(false);
  });
});

describe("orçamentos da Lia no grupo", () => {
  it("5 respostas por hora por sala; 1 aviso de 'última no seu tamanho' a cada 7 dias", () => {
    expect(mentionReplyAllowed({ repliesLastHour: 4 })).toBe(true);
    expect(mentionReplyAllowed({ repliesLastHour: 5 })).toBe(false);
    expect(mentionReplyAllowed({ repliesLastHour: 1, limit: 1 })).toBe(false);
    const now = new Date("2026-09-22T13:00:00Z");
    expect(lastUnitNoticeAllowed({ lastNoticeAt: null, now })).toBe(true);
    expect(lastUnitNoticeAllowed({ lastNoticeAt: new Date("2026-09-15T13:00:00Z"), now })).toBe(true);
    expect(lastUnitNoticeAllowed({ lastNoticeAt: new Date("2026-09-16T13:00:00Z"), now })).toBe(false);
    expect(lastUnitNoticeAllowed({ lastNoticeAt: new Date("2026-09-20T13:00:00Z"), now, minDays: 1 })).toBe(true);
  });

  it("clampMentionReply: 2 linhas, sem cabeçalho nem ---, corte em frase ou em palavra com reticência", () => {
    expect(clampMentionReply("## Oi\n\nTem sim: 2 em M.\n---\nTe mando no privado?\nTerceira linha some.")).toBe("Tem sim: 2 em M.\nTe mando no privado?");
    const long = `${"Tem sim em M. ".repeat(30)}Te mando no privado?`;
    const clamped = clampMentionReply(long);
    expect(clamped.length).toBeLessThanOrEqual(MENTION_REPLY_MAX_CHARS);
    expect(clamped.endsWith(".")).toBe(true);
    const noSentence = "palavra ".repeat(60).trim();
    const word = clampMentionReply(noSentence);
    expect(word.length).toBeLessThanOrEqual(MENTION_REPLY_MAX_CHARS + 1);
    expect(word.endsWith("…")).toBe(true);
    expect(clampMentionReply("curto")).toBe("curto");
  });
});

describe("prompt da Lia no grupo", () => {
  it("é público e contido: nome, grupo, só ferramentas de catálogo, privado para o resto, nunca 'maison'; determinístico", () => {
    const prompt = buildGroupMentionPrompt({ storeName: "TRIVÉ", sellerName: "", groupName: "Provador TRIVÉ", siteUrl: "https://trivemaison.com.br", storeMap: "12 peças" });
    expect(prompt).toContain('Você é Lia, a vendedora da TRIVÉ');
    expect(prompt).toContain('no grupo "Provador TRIVÉ"');
    expect(prompt).toContain(`no máximo 2 linhas e ${MENTION_REPLY_MAX_CHARS} caracteres`);
    expect(prompt).toContain("listar_produtos e detalhar_produto");
    expect(prompt).toContain("acontecem SÓ no privado");
    expect(prompt).toContain("PLANTA DA LOJA");
    expect(prompt).toMatch(/nunca "maison"/);
    expect(prompt).not.toMatch(/adicionar_a_sacola|reservar_peca|criar_pedido/);
    expect(buildGroupMentionPrompt({ storeName: "TRIVÉ", sellerName: "Lia", groupName: "P", siteUrl: "x" })).not.toContain("PLANTA DA LOJA");
    expect(prompt).toBe(buildGroupMentionPrompt({ storeName: "TRIVÉ", sellerName: "", groupName: "Provador TRIVÉ", siteUrl: "https://trivemaison.com.br", storeMap: "12 peças" }));
  });
});
