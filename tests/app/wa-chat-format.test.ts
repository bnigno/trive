// Formatação do painel de conversas: quem atende (com a vendedora ligada ou
// não), prefixo da prévia, rótulo da conversa, telefone e "respondendo…".
import { describe, expect, it } from "vitest";

import {
  attendantBadge,
  conversationLabel,
  describeTools,
  formatPhoneBR,
  isSellerTyping,
  maskPhone,
  originPrefix,
} from "@/app/admin/(protected)/whatsapp/conversas/format";

const LIA = { botEnabled: true, sellerName: "Lia" };

describe("attendantBadge", () => {
  it("open com a vendedora ligada: com a vendedora; desligada: cai com você", () => {
    expect(attendantBadge("open", null, LIA)).toEqual({
      label: "Com a Lia",
      tone: "success",
      attendant: "seller",
    });
    expect(attendantBadge("open", null, { ...LIA, botEnabled: false })).toEqual({
      label: "Lia desligada",
      tone: "danger",
      attendant: "you",
    });
  });

  it("human, pausa pós-transferência e encerrada", () => {
    expect(attendantBadge("human", null, LIA).attendant).toBe("you");
    const future = new Date(Date.now() + 60_000);
    expect(attendantBadge("open", future, LIA)).toMatchObject({
      label: "Lia em pausa",
      attendant: "you",
    });
    const past = new Date(Date.now() - 60_000);
    expect(attendantBadge("open", past, LIA).attendant).toBe("seller");
    expect(attendantBadge("closed", null, LIA)).toMatchObject({
      label: "Encerrada",
      attendant: "nobody",
    });
  });

  it("nome vazio cai em 'a vendedora'", () => {
    expect(attendantBadge("open", null, { botEnabled: true, sellerName: " " }).label).toBe(
      "Com a vendedora",
    );
  });
});

describe("rótulos", () => {
  it("prefixo da prévia por origem", () => {
    expect(originPrefix("manual", "Lia")).toBe("Você");
    expect(originPrefix("bot", "Lia")).toBe("Lia");
    expect(originPrefix("auto", "Lia")).toBe("Auto");
    expect(originPrefix("customer", "Lia")).toBeNull();
    expect(originPrefix(null, "Lia")).toBeNull();
  });

  it("rótulo da conversa: cadastro > nome do WhatsApp > telefone mascarado; dono = avisos", () => {
    const base = { phoneE164: "+5511999991234", isOwnerNotices: false };
    expect(conversationLabel({ ...base, customerName: "Maria", displayName: "Ma" })).toBe("Maria");
    expect(conversationLabel({ ...base, customerName: null, displayName: "Ma 🌸" })).toBe("Ma 🌸");
    expect(conversationLabel({ ...base, customerName: null, displayName: null })).toBe(
      maskPhone("+5511999991234"),
    );
    expect(
      conversationLabel({ ...base, customerName: "X", displayName: null, isOwnerNotices: true }),
    ).toBe("Avisos internos");
  });

  it("descreve as ferramentas do turno sem repetir", () => {
    expect(describeTools(["listar_produtos", "detalhar_produto", "listar_produtos"])).toBe(
      "mostrou o catálogo · detalhou uma peça",
    );
    expect(describeTools([])).toBeNull();
    expect(describeTools(["ferramenta_nova"])).toBe("ferramenta_nova");
  });

  it("formata o telefone só para o painel da cliente", () => {
    expect(formatPhoneBR("+5511999991234")).toBe("(11) 99999-1234");
    expect(formatPhoneBR("+551133334444")).toBe("(11) 3333-4444");
    expect(formatPhoneBR("+12025550123")).toBe("+12025550123");
  });
});

describe("isSellerTyping", () => {
  const now = Date.parse("2026-09-04T12:00:30.000Z");
  it("só com a vendedora atendendo, última mensagem da cliente e menos de 45 s", () => {
    expect(
      isSellerTyping({
        attendant: "seller",
        lastMessageDirection: "inbound",
        lastMessageAt: "2026-09-04T12:00:10.000Z",
        now,
      }),
    ).toBe(true);
    expect(
      isSellerTyping({
        attendant: "seller",
        lastMessageDirection: "inbound",
        lastMessageAt: "2026-09-04T11:59:00.000Z",
        now,
      }),
    ).toBe(false);
    expect(
      isSellerTyping({
        attendant: "you",
        lastMessageDirection: "inbound",
        lastMessageAt: "2026-09-04T12:00:10.000Z",
        now,
      }),
    ).toBe(false);
    expect(
      isSellerTyping({
        attendant: "seller",
        lastMessageDirection: "outbound",
        lastMessageAt: "2026-09-04T12:00:10.000Z",
        now,
      }),
    ).toBe(false);
  });
});
