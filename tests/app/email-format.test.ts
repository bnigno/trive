import { describe, expect, it } from "vitest";

import {
  countAwaitingThreads,
  dayKeySP,
  daySeparatorLabel,
  formatAttachmentSize,
  isAwaitingReply,
  listTimestamp,
  messageTimestamp,
  replySubjectFor,
  senderInitials,
  senderLabel,
  subjectChanged,
  subjectOrPlaceholder,
} from "@/app/admin/(protected)/emails/email-format";

// Quarta-feira, 26/08/2026, meio-dia em São Paulo (UTC-3). Todos os casos
// abaixo fixam "agora" para o resultado não depender do dia em que a suíte
// roda — nem do fuso da máquina de quem roda.
const NOW = new Date("2026-08-26T15:00:00Z");

describe("caixa de e-mail — data e hora", () => {
  it("hoje mostra só a hora, no fuso de São Paulo", () => {
    expect(listTimestamp("2026-08-26T17:30:00Z", NOW)).toBe("14:30");
  });

  it("ontem vira a palavra 'ontem'", () => {
    expect(listTimestamp("2026-08-25T20:00:00Z", NOW)).toBe("ontem");
  });

  it("o dia é o de São Paulo, não o do UTC", () => {
    // 26/08 às 02:00 UTC ainda é a noite do dia 25 em São Paulo: pela conta
    // do UTC daria "hoje", e para o dono é ontem.
    expect(listTimestamp("2026-08-26T02:00:00Z", NOW)).toBe("ontem");
    expect(dayKeySP("2026-08-26T02:00:00Z")).toBe("2026-08-25");
  });

  it("na última semana mostra o dia da semana", () => {
    expect(listTimestamp("2026-08-23T15:00:00Z", NOW)).toBe("domingo");
  });

  it("mais antigo que uma semana mostra dia/mês", () => {
    expect(listTimestamp("2026-08-16T15:00:00Z", NOW)).toBe("16/08");
  });

  it("separador do dia fala como gente", () => {
    expect(daySeparatorLabel("2026-08-26T17:30:00Z", NOW)).toBe("Hoje");
    expect(daySeparatorLabel("2026-08-25T20:00:00Z", NOW)).toBe("Ontem");
    expect(daySeparatorLabel("2026-08-16T15:00:00Z", NOW)).toBe(
      "16 de agosto de 2026",
    );
  });

  it("cabeçalho do e-mail junta dia e hora", () => {
    expect(messageTimestamp("2026-08-26T17:30:00Z", NOW)).toBe("Hoje às 14:30");
    expect(messageTimestamp("2026-08-16T15:00:00Z", NOW)).toBe(
      "16 de agosto de 2026 às 12:00",
    );
  });
});

describe("caixa de e-mail — remetente", () => {
  it("o nome do cliente cadastrado ganha do nome do cabeçalho", () => {
    expect(
      senderLabel({
        customerName: "Maria Silva",
        participantName: "MARIA S.",
        participantEmail: "maria@exemplo.com",
      }),
    ).toBe("Maria Silva");
  });

  it("sem cliente cadastrado, usa o nome que veio no e-mail", () => {
    expect(
      senderLabel({
        customerName: null,
        participantName: "Maria S.",
        participantEmail: "maria@exemplo.com",
      }),
    ).toBe("Maria S.");
  });

  it("sem nome nenhum, mostra o endereço em vez de inventar apelido", () => {
    expect(
      senderLabel({
        customerName: "   ",
        participantName: null,
        participantEmail: "maria@exemplo.com",
      }),
    ).toBe("maria@exemplo.com");
  });

  it("iniciais do avatar saem do nome ou do endereço", () => {
    expect(senderInitials("Maria Silva")).toBe("MS");
    expect(senderInitials("maria.silva@exemplo.com")).toBe("MS");
    expect(senderInitials("contato@exemplo.com")).toBe("C");
    expect(senderInitials("   ")).toBe("?");
    expect(senderInitials("@sem-nome.com")).toBe("?");
  });
});

describe("caixa de e-mail — assunto", () => {
  it("assunto vazio nunca vira linha em branco", () => {
    expect(subjectOrPlaceholder("   ")).toBe("(sem assunto)");
    expect(subjectOrPlaceholder(" Pedido #12 ")).toBe("Pedido #12");
  });

  it("a resposta não empilha Re: em cima de Re:", () => {
    expect(replySubjectFor("Pedido #12")).toBe("Re: Pedido #12");
    expect(replySubjectFor("Re: Re: Enc: Pedido  #12")).toBe("Re: Pedido #12");
    expect(replySubjectFor("   ")).toBe("Re: (sem assunto)");
  });

  it("responder com 'Re:' não conta como assunto novo", () => {
    expect(subjectChanged("Re: Pedido #12", "Pedido #12")).toBe(false);
    expect(subjectChanged("PEDIDO #12", "Pedido #12")).toBe(false);
    expect(subjectChanged("", "Pedido #12")).toBe(false);
  });

  it("assunto trocado no meio da conversa aparece", () => {
    expect(subjectChanged("Troca de tamanho", "Pedido #12")).toBe(true);
  });
});

describe("caixa de e-mail — tamanho do anexo", () => {
  it("escreve o tamanho em português", () => {
    expect(formatAttachmentSize(0)).toBe("0 bytes");
    expect(formatAttachmentSize(1)).toBe("1 byte");
    expect(formatAttachmentSize(820)).toBe("820 bytes");
    expect(formatAttachmentSize(1024)).toBe("1 KB");
    expect(formatAttachmentSize(1536)).toBe("1,5 KB");
    expect(formatAttachmentSize(1_048_576)).toBe("1 MB");
    expect(formatAttachmentSize(1_572_864)).toBe("1,5 MB");
  });

  it("número impossível não vira 'NaN' na tela", () => {
    expect(formatAttachmentSize(Number.NaN)).toBe("tamanho desconhecido");
    expect(formatAttachmentSize(-5)).toBe("tamanho desconhecido");
  });
});

describe("caixa de e-mail — quem está esperando resposta", () => {
  it("pendente é conversa na caixa com mensagem não aberta", () => {
    expect(isAwaitingReply({ status: "open", unreadCount: 2 })).toBe(true);
  });

  it("conversa lida não está esperando", () => {
    expect(isAwaitingReply({ status: "open", unreadCount: 0 })).toBe(false);
  });

  it("conversa arquivada nunca conta, mesmo com mensagem não aberta", () => {
    // O serviço conta assim (countThreadsAwaiting só olha status 'open'); se
    // a tela divergisse, o crachá do menu e a lista mostrariam números
    // diferentes para a mesma caixa.
    expect(isAwaitingReply({ status: "archived", unreadCount: 3 })).toBe(false);
  });

  it("a contagem soma conversas, não mensagens", () => {
    const threads = [
      { status: "open", unreadCount: 5 },
      { status: "open", unreadCount: 1 },
      { status: "open", unreadCount: 0 },
      { status: "archived", unreadCount: 9 },
    ];
    expect(countAwaitingThreads(threads)).toBe(2);
    expect(countAwaitingThreads([])).toBe(0);
  });
});
