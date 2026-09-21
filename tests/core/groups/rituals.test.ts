import { describe, expect, it } from "vitest";

import {
  CHEGADAS_MAX_ITEMS,
  formatPriceShort,
  formatStockLine,
  GROUP_POST_MAX_CHARS,
  groupPostProblem,
  POLL_PROBLEM_MESSAGES,
  pollProblem,
  renderChegadasPost,
  renderPoll,
  renderPollResultPost,
  renderQuemVestiuPost,
  renderWelcomeCard,
  tallyPoll,
} from "@/core/groups/rituals";

const LINK = "https://trivemaison.com.br/ig/prov-20260922-chegadas";

describe("estoque de verdade na linha da peça", () => {
  it("números quando são poucos, só os tamanhos quando sobra, 'só' com um tamanho, 'esgotou' sem nada", () => {
    expect(formatStockLine([{ size: "P", quantity: 2 }, { size: "M", quantity: 3 }, { size: "G", quantity: 1 }])).toBe("tem 2 P, 3 M, 1 G");
    expect(formatStockLine([{ size: "P", quantity: 4 }, { size: "M", quantity: 9 }, { size: "G", quantity: 5 }])).toBe("tem P, M e G");
    expect(formatStockLine([{ size: "M", quantity: 5 }, { size: "G", quantity: 4 }])).toBe("tem M e G");
    expect(formatStockLine([{ size: "M", quantity: 2 }])).toBe("só 2 M");
    expect(formatStockLine([{ size: "M", quantity: 7 }])).toBe("tem M");
    expect(formatStockLine([{ size: "P", quantity: 0 }, { size: "M", quantity: 2 }])).toBe("só 2 M");
    expect(formatStockLine([{ size: "P", quantity: 0 }])).toBe("esgotou");
    expect(formatStockLine([])).toBe("esgotou");
  });

  it("preço curto: redondo sem centavos, quebrado com", () => {
    expect(formatPriceShort(28900)).toBe("R$ 289");
    expect(formatPriceShort(18990)).toBe("R$ 189,90");
  });
});

describe("Passou pelo Provador (terça)", () => {
  const items = [
    { name: "Vestido Terracota", priceCents: 28900, stockBySize: [{ size: "P", quantity: 2 }, { size: "M", quantity: 3 }, { size: "G", quantity: 1 }] },
    { name: "Blusa Marfim de linho", priceCents: 17900, stockBySize: [{ size: "M", quantity: 6 }, { size: "G", quantity: 4 }] },
    { name: "Calça Areia", priceCents: 24900, stockBySize: [{ size: "M", quantity: 2 }] },
  ];

  it("renderiza a mensagem da estratégia: numeração, preço, estoque, vitrine, link da Lia e preço protegido", () => {
    const text = renderChegadasPost({ items, liaLink: LINK, vitrineWhen: "amanhã às 9h", priceProtectionDays: 14 });
    expect(text).toBe(
      [
        "Passou pelo Provador hoje:",
        "",
        "1. Vestido Terracota — R$ 289 · tem 2 P, 3 M, 1 G",
        "2. Blusa Marfim de linho — R$ 179 · tem M e G",
        "3. Calça Areia — R$ 249 · só 2 M",
        "",
        `Vão para a vitrine amanhã às 9h. Quem quiser antes: ${LINK} — eu seguro por 24 h no seu tamanho.`,
        "Preço protegido: se baixar em 14 dias, a diferença volta em cupom.",
      ].join("\n"),
    );
    expect(text).not.toMatch(/últimas unidades|compre agora|imperdível/i);
  });

  it("sem preço protegido e já na vitrine: uma peça, verbo no singular, sem a linha da promessa", () => {
    const text = renderChegadasPost({ items: items.slice(0, 1), liaLink: LINK, holdHours: 48 });
    expect(text).toContain(`Quer ela? ${LINK} — eu seguro por 48 h no seu tamanho.`);
    expect(text).not.toContain("Preço protegido");
    expect(text).not.toContain("Vão");
  });

  it("corta em 3 peças e recusa post sem peça", () => {
    const many = [...items, { name: "Quarta", priceCents: 100, stockBySize: [{ size: "U", quantity: 1 }] }];
    expect(renderChegadasPost({ items: many, liaLink: LINK })).not.toContain("Quarta");
    expect(CHEGADAS_MAX_ITEMS).toBe(3);
    expect(() => renderChegadasPost({ items: [], liaLink: LINK })).toThrow();
  });
});

describe("Vocês decidem (quinta)", () => {
  it("renderiza a enquete com a promessa e a recompensa de quem votou", () => {
    const poll = renderPoll({
      question: "A Blusa Marfim volta em uma cor a mais — qual?",
      options: [" Verde-oliva", "Vinho ", "Azul-noite"],
      outcome: "chega em 15 dias",
      voterHoldHours: 24,
    });
    expect(poll).toEqual({
      message: "Vocês decidem. A Blusa Marfim volta em uma cor a mais — qual?\nA que ganhar chega em 15 dias. Quem votou nela tem 24 h de reserva antes de todo mundo.",
      options: ["Verde-oliva", "Vinho", "Azul-noite"],
    });
    expect(renderPoll({ question: "Qual?", options: ["A", "B"] }).message).toBe("Vocês decidem. Qual?");
  });

  it("pollProblem na ordem em que a dona corrige; renderPoll lança com a frase", () => {
    expect(pollProblem({ question: " ", options: ["A", "B"] })).toBe("pergunta_vazia");
    expect(pollProblem({ question: "x".repeat(256), options: ["A", "B"] })).toBe("pergunta_longa");
    expect(pollProblem({ question: "Qual?", options: ["A"] })).toBe("poucas_opcoes");
    expect(pollProblem({ question: "Qual?", options: Array.from({ length: 13 }, (_, i) => `O${i}`) })).toBe("muitas_opcoes");
    expect(pollProblem({ question: "Qual?", options: ["A", " "] })).toBe("opcao_vazia");
    expect(pollProblem({ question: "Qual?", options: ["A", "x".repeat(101)] })).toBe("opcao_longa");
    expect(pollProblem({ question: "Qual?", options: ["Vinho", "vinho"] })).toBe("opcao_repetida");
    expect(pollProblem({ question: "Qual?", options: ["A", "B"] })).toBeNull();
    expect(() => renderPoll({ question: "Qual?", options: ["A"] })).toThrow(POLL_PROBLEM_MESSAGES.poucas_opcoes);
  });

  it("apura: última escolha de cada pessoa, opções desconhecidas ignoradas, empate = ordem da dona, ninguém votou = sem vencedora", () => {
    const options = ["Verde-oliva", "Vinho", "Azul-noite"];
    const result = tallyPoll(options, [["Vinho"], ["Verde-oliva"], ["Verde-oliva", "Azul-noite"], ["Roxo"], []]);
    expect(result).toEqual({
      tally: [
        { option: "Verde-oliva", votes: 2 },
        { option: "Vinho", votes: 1 },
        { option: "Azul-noite", votes: 1 },
      ],
      winner: "Verde-oliva",
      voters: 3,
    });
    expect(tallyPoll(options, [["Vinho"], ["Azul-noite"]]).winner).toBe("Vinho");
    expect(tallyPoll(options, []).winner).toBeNull();
    // A mesma opção duas vezes num voto conta uma.
    expect(tallyPoll(options, [["Vinho", "Vinho"]]).tally[1]?.votes).toBe(1);
  });

  it("resultado: 'Deu X: n de m votos' + promessa + reserva no privado", () => {
    expect(renderPollResultPost({ winner: "Verde-oliva", winnerVotes: 14, voters: 23, outcome: "chega em 15 dias", voterHoldHours: 24 })).toBe(
      "Deu Verde-oliva: 14 de 23 votos.\nEla chega em 15 dias. Quem votou nela recebe 24 h de reserva no privado quando chegar.",
    );
    expect(renderPollResultPost({ winner: "Vinho", winnerVotes: 1, voters: 1 })).toBe("Deu Vinho: 1 de 1 voto.");
  });
});

describe("Quem vestiu (sábado) e boas-vindas", () => {
  it("quem vestiu: nome, ocasião, peça, tamanho, consentimento, Lia no privado e o cupom da foto", () => {
    const text = renderQuemVestiuPost({
      looks: [{ firstName: "Ana", productName: "o Vestido Terracota", size: "M", occasion: "no casamento da irmã" }],
      liaLink: LINK,
      until: "21h",
      photoCoupon: true,
    });
    expect(text).toBe(
      [
        "Ana no casamento da irmã, com o Vestido Terracota em M. Ela mandou a foto e deixou a gente mostrar.",
        "",
        `Tem ocasião chegando? Estou no privado até as 21h montando look com data marcada — me diz o dia e eu cuido do resto: ${LINK}`,
        "",
        "Mandou foto vestindo a peça? Vira cupom na próxima compra.",
      ].join("\n"),
    );
    const two = renderQuemVestiuPost({
      looks: [
        { firstName: "Ana", productName: "a Blusa Marfim" },
        { firstName: "Bia", productName: "a Calça Areia", size: "G" },
        { firstName: "Cris", productName: "x" },
      ],
      liaLink: LINK,
      until: "21h",
    });
    expect(two).toContain("Ana, com a Blusa Marfim. Bia, com a Calça Areia em G. Elas mandaram as fotos e deixaram a gente mostrar.");
    expect(two).not.toContain("Cris");
    expect(two).not.toContain("cupom");
    expect(() => renderQuemVestiuPost({ looks: [], liaLink: LINK, until: "21h" })).toThrow();
  });

  it("cartão de boas-vindas: rituais, teto, janela, reação, @Lia, número visível, só privado e SAIR", () => {
    const text = renderWelcomeCard({ storeName: "TRIVÉ", sellerName: "Lia", firstName: "Ana" });
    expect(text.startsWith("Bem-vinda ao Provador TRIVÉ, Ana. Aqui as peças passam antes de ir para a vitrine.")).toBe(true);
    expect(text).toContain("• Terça — o que chegou");
    expect(text).toContain("• Quinta — vocês decidem");
    expect(text).toContain("• Sábado — quem vestiu");
    expect(text).toContain("três mensagens por semana, entre 9h e 21h");
    expect(text).toContain("Reage ❤️");
    expect(text).toContain("(@Lia)");
    expect(text).toContain("Seu número fica visível");
    expect(text).toContain('"só privado"');
    expect(text).toContain('"SAIR" desliga tudo');
    expect(text).not.toMatch(/maison/i);
    const custom = renderWelcomeCard({ storeName: "TRIVÉ", sellerName: "Lia", windowStartHour: 10, windowEndHour: 20, postsPerWeek: 2 });
    expect(custom).toContain("Bem-vinda ao Provador TRIVÉ. ");
    expect(custom).toContain("duas mensagens por semana, entre 10h e 20h");
  });

  it("post vazio ou muro de texto é recusado antes de agendar", () => {
    expect(groupPostProblem("  ")).toBe("O post está vazio.");
    expect(groupPostProblem("x".repeat(GROUP_POST_MAX_CHARS + 1))).toContain("muro de texto");
    expect(groupPostProblem("Passou pelo Provador hoje")).toBeNull();
  });
});
