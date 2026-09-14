import { describe, expect, it } from "vitest";

import { copilotBlockedText, EFFECT_TOOLS, isToolBlockedInCopilot, READ_TOOLS, resolveBotMode, STATE_TOOLS, suggestionAgeLabel } from "@/core/bot/copilot";
import { BOT_TOOL_NAMES } from "@/core/bot/tools";

describe("copiloto", () => {
  it("toda ferramenta está classificada exatamente uma vez (efeito, estado ou leitura)", () => {
    for (const name of BOT_TOOL_NAMES) {
      const buckets = [EFFECT_TOOLS.has(name), STATE_TOOLS.has(name), READ_TOOLS.has(name)].filter(Boolean).length;
      expect(buckets, name).toBe(1);
    }
    expect(EFFECT_TOOLS.size + STATE_TOOLS.size + READ_TOOLS.size).toBe(BOT_TOOL_NAMES.length);
    // O que sai da conversa espera a dona; consultar e anotar não.
    for (const blocked of ["criar_pedido", "enviar_chave_pix", "avisar_dono", "reservar_peca", "transferir_para_atendente", "agendar_retorno", "registrar_foto_com_a_peca", "confirmar_entrega"] as const) {
      expect(isToolBlockedInCopilot(blocked), blocked).toBe(true);
    }
    for (const allowed of ["listar_produtos", "detalhar_produto", "cotar_frete", "adicionar_a_sacola", "anotar", "atualizar_cartela", "status_do_pedido"] as const) {
      expect(isToolBlockedInCopilot(allowed), allowed).toBe(false);
    }
    expect(copilotBlockedText("criar_pedido")).toContain("criar_pedido");
  });

  it("o modo da conversa vence o da loja; valor torto cai em autônoma", () => {
    expect(resolveBotMode("autonomous", null)).toBe("autonomous");
    expect(resolveBotMode("copilot", null)).toBe("copilot");
    expect(resolveBotMode("copilot", "autonomous")).toBe("autonomous");
    expect(resolveBotMode("autonomous", "copilot")).toBe("copilot");
    expect(resolveBotMode(undefined, undefined)).toBe("autonomous");
    expect(resolveBotMode("piloto", "x")).toBe("autonomous");
  });

  it("idade da sugestão", () => {
    const now = new Date("2026-09-14T18:00:00Z");
    expect(suggestionAgeLabel(new Date("2026-09-14T17:59:40Z"), now)).toBe("agora");
    expect(suggestionAgeLabel(new Date("2026-09-14T17:57:00Z"), now)).toBe("há 3 min");
    expect(suggestionAgeLabel(new Date("2026-09-14T16:00:00Z"), now)).toBe("há 2 h");
    expect(suggestionAgeLabel(new Date("2026-09-12T16:00:00Z"), now)).toBe("há 2 d");
  });
});
