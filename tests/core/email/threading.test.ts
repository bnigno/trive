// Threading puro: em que conversa a mensagem entra e o que a resposta precisa
// carregar para o Gmail do cliente encaixá-la lá. Sem relógio e sem sorteio —
// a mesma entrada tem de dar a mesma chave sempre.
import { describe, expect, it } from "vitest";

import {
  buildReplyHeaders,
  normalizeMessageId,
  normalizeSubject,
  threadKeyFor,
  ThreadingError,
} from "@/core/email/threading";

describe("normalizeSubject", () => {
  const cases: Array<[string, string]> = [
    ["Re: Pedido #12", "Pedido #12"],
    ["Re: Re: Enc: Pedido #12", "Pedido #12"],
    ["RE: ENC: RES: Orçamento", "Orçamento"],
    ["Fwd: Re[2]: Troca de tamanho", "Troca de tamanho"],
    ["  Re:   Pedido   #12  ", "Pedido #12"],
    ["Pedido #12", "Pedido #12"],
    // "Resumo" e "Encaixe" COMEÇAM com prefixos conhecidos mas não são
    // prefixos: o corte só vale quando vem ":" logo depois.
    ["Resumo do mês", "Resumo do mês"],
    ["Encaixe na agenda", "Encaixe na agenda"],
    ["", ""],
  ];

  for (const [input, expected] of cases) {
    it(`"${input}" → "${expected}"`, () => {
      expect(normalizeSubject(input)).toBe(expected);
    });
  }
});

describe("normalizeMessageId", () => {
  it("tira os <> e o espaço em volta", () => {
    expect(normalizeMessageId("  <abc@mail.com>  ")).toBe("abc@mail.com");
    expect(normalizeMessageId("abc@mail.com")).toBe("abc@mail.com");
  });

  it("devolve null quando não sobra id nenhum", () => {
    expect(normalizeMessageId(undefined)).toBeNull();
    expect(normalizeMessageId("")).toBeNull();
    expect(normalizeMessageId("<>")).toBeNull();
  });
});

describe("threadKeyFor", () => {
  const clienteEmail = "cliente@example.com";

  it("cadeia de resposta: todas as mensagens caem na RAIZ de references", () => {
    const raiz = "<raiz@example.com>";
    const segunda = threadKeyFor({
      messageId: "<m2@trive.local>",
      inReplyTo: raiz,
      references: [raiz],
      subject: "Re: Pedido #12",
      participantEmail: clienteEmail,
    });
    const terceira = threadKeyFor({
      messageId: "<m3@example.com>",
      inReplyTo: "<m2@trive.local>",
      references: [raiz, "<m2@trive.local>"],
      subject: "Re: Re: Pedido #12",
      participantEmail: clienteEmail,
    });

    expect(segunda).toBe("mid:raiz@example.com");
    expect(terceira).toBe(segunda);
  });

  it("sem references, cai no In-Reply-To", () => {
    expect(
      threadKeyFor({
        messageId: "<m2@trive.local>",
        inReplyTo: "<raiz@example.com>",
        references: [],
        subject: "Re: Pedido #12",
        participantEmail: clienteEmail,
      }),
    ).toBe("mid:raiz@example.com");
  });

  it("references vazias/em branco não valem como raiz", () => {
    expect(
      threadKeyFor({
        messageId: "<m2@trive.local>",
        inReplyTo: "<raiz@example.com>",
        references: ["", "  ", "<>"],
        subject: "Re: Pedido #12",
        participantEmail: clienteEmail,
      }),
    ).toBe("mid:raiz@example.com");
  });

  it("mensagem órfã usa assunto normalizado + participante", () => {
    const primeira = threadKeyFor({
      messageId: "<m1@example.com>",
      references: [],
      subject: "Dúvida sobre o pedido",
      participantEmail: clienteEmail,
    });

    expect(primeira.startsWith("sub:")).toBe(true);
    // Determinístico: mesma entrada, mesma chave.
    expect(
      threadKeyFor({
        messageId: "<outro@example.com>",
        references: [],
        subject: "  Re:  Dúvida sobre o pedido ",
        participantEmail: "  CLIENTE@example.com ",
      }),
    ).toBe(primeira);
  });

  it("dois assuntos iguais de remetentes diferentes NÃO colidem", () => {
    const daAna = threadKeyFor({
      messageId: "<a1@example.com>",
      references: [],
      subject: "Dúvida sobre o pedido",
      participantEmail: "ana@example.com",
    });
    const doBruno = threadKeyFor({
      messageId: "<b1@example.com>",
      references: [],
      subject: "Dúvida sobre o pedido",
      participantEmail: "bruno@example.com",
    });

    expect(daAna).not.toBe(doBruno);
  });

  it("assuntos diferentes do mesmo remetente NÃO colidem", () => {
    const primeiro = threadKeyFor({
      messageId: "<a1@example.com>",
      references: [],
      subject: "Dúvida sobre o pedido",
      participantEmail: clienteEmail,
    });
    const segundo = threadKeyFor({
      messageId: "<a2@example.com>",
      references: [],
      subject: "Troca de tamanho",
      participantEmail: clienteEmail,
    });

    expect(primeiro).not.toBe(segundo);
  });
});

describe("buildReplyHeaders", () => {
  it("References = cadeia da mensagem + a própria mensagem respondida", () => {
    expect(
      buildReplyHeaders({
        messageId: "<m2@example.com>",
        references: ["<raiz@example.com>"],
      }),
    ).toEqual({
      "In-Reply-To": "<m2@example.com>",
      References: "<raiz@example.com> <m2@example.com>",
    });
  });

  it("mensagem órfã: References tem só ela mesma", () => {
    expect(
      buildReplyHeaders({ messageId: "raiz@example.com", references: [] }),
    ).toEqual({
      "In-Reply-To": "<raiz@example.com>",
      References: "<raiz@example.com>",
    });
  });

  it("não repete um id que já estava na cadeia", () => {
    expect(
      buildReplyHeaders({
        messageId: "<m2@example.com>",
        references: ["<raiz@example.com>", "<m2@example.com>"],
      }).References,
    ).toBe("<raiz@example.com> <m2@example.com>");
  });

  it("cadeia longa é cortada mantendo a raiz e as mais recentes", () => {
    const references = Array.from(
      { length: 30 },
      (_, index) => `<r${index + 1}@example.com>`,
    );

    const referencias = buildReplyHeaders({
      messageId: "<atual@example.com>",
      references,
    }).References.split(" ");

    expect(referencias).toHaveLength(20);
    expect(referencias[0]).toBe("<r1@example.com>");
    expect(referencias[1]).toBe("<r13@example.com>");
    expect(referencias[19]).toBe("<atual@example.com>");
  });

  it("recusa mensagem sem Message-ID", () => {
    expect(() =>
      buildReplyHeaders({ messageId: "  ", references: ["<raiz@x.com>"] }),
    ).toThrow(ThreadingError);
  });
});
