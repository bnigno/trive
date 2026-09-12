// A carta de estreia (PURO): o que é primeira compra (pela ordem de
// pagamento, presente não conta), a limpeza da carta e da assinatura, o
// primeiro nome, o orçamento do papel e a ordem de impressão.
import { describe, expect, it } from "vitest";

import {
  COUNTED_STATUSES,
  DEBUT_LETTER_GEOMETRY,
  DEBUT_LETTER_MAX,
  DEBUT_LETTER_MAX_LINES,
  DEBUT_SIGNATURE_MAX,
  debutFirstName,
  debutLetterFontSize,
  debutLetterLayout,
  debutLetterProblem,
  editionPrintSet,
  isCountedStatus,
  isFirstPurchase,
  normalizeDebutLetter,
  normalizeDebutSignature,
} from "@/core/edition/debut";
import { textWidthUnits } from "@/core/edition/text";

describe("isFirstPurchase / status que contam", () => {
  it("primeira compra é não ter nenhum pedido pago antes e não ser presente; reembolsado conta, cancelado não", () => {
    expect(isFirstPurchase({ priorCountedOrders: 0, isGift: false })).toBe(true);
    expect(isFirstPurchase({ priorCountedOrders: 1, isGift: false })).toBe(false);
    // Presente: a caixa vai para outra pessoa — a carta espera a primeira compra para ela mesma.
    expect(isFirstPurchase({ priorCountedOrders: 0, isGift: true })).toBe(false);
    expect(COUNTED_STATUSES).toEqual(["paid", "preparing", "shipped", "delivered", "refunded"]);
    expect(isCountedStatus("paid")).toBe(true);
    expect(isCountedStatus("refunded")).toBe(true);
    expect(isCountedStatus("pending_payment")).toBe(false);
    expect(isCountedStatus("canceled")).toBe(false);
  });
});

describe("normalizeDebutLetter / normalizeDebutSignature", () => {
  it("tira emoji sem deixar espaço antes do ponto, mantém acentos (mesmo em NFD) e R$; junta linhas vazias; vazio desliga a carta", () => {
    expect(normalizeDebutLetter("  Bem-vinda 🤎 à maison.\n\n\n\nCom carinho.  ")).toBe("Bem-vinda à maison.\n\nCom carinho.");
    expect(normalizeDebutLetter("Que bom ter você por aqui 🤎.")).toBe("Que bom ter você por aqui.");
    expect(normalizeDebutLetter("Belém, R$ 50 a 35°C")).toBe("Belém, R$ 50 a 35°C");
    expect(normalizeDebutLetter("Linha um\r\nLinha dois")).toBe("Linha um\nLinha dois");
    expect(normalizeDebutLetter("   ")).toBeNull();
    expect(normalizeDebutLetter("…")).toBeNull();
    expect(normalizeDebutLetter(null)).toBeNull();
  });

  it("não corta em silêncio: uma carta comprida continua inteira, e o problema vem de debutLetterProblem", () => {
    const muitas = normalizeDebutLetter(Array.from({ length: 20 }, (_, i) => `linha ${i + 1}`).join("\n"))!;
    expect(muitas.split("\n")).toHaveLength(20);
    expect(debutLetterProblem(muitas)).toMatch(/20 linhas/);
    const comprida = normalizeDebutLetter("palavra ".repeat(200))!;
    expect(comprida.length).toBeGreaterThan(DEBUT_LETTER_MAX);
    expect(debutLetterProblem(comprida)).toMatch(/caracteres/);
    expect(debutLetterProblem(null)).toBeNull();
    expect(debutLetterProblem("Bem-vinda.")).toBeNull();
    expect(DEBUT_LETTER_MAX_LINES).toBe(12);
  });

  it("assinatura numa linha, sem emoji, no teto de largura, com padrão", () => {
    expect(normalizeDebutSignature("  Marina,\ncuradora 🤎 ")).toBe("Marina, curadora");
    expect(normalizeDebutSignature("")).toBe("A curadora");
    expect(normalizeDebutSignature("🤎")).toBe("A curadora");
    const longa = normalizeDebutSignature("MARINA DA SILVA, CURADORA DA TRIVÉ MAISON EM BELÉM DO PARÁ");
    expect(textWidthUnits(longa, "serif")).toBeLessThanOrEqual(DEBUT_SIGNATURE_MAX);
    expect(longa).not.toMatch(/[\s,]$/);
  });
});

describe("debutFirstName", () => {
  it("primeiro nome com inicial maiúscula, apóstrofo e hífen respeitados; emoji na frente pula; sem nome, 'você'", () => {
    expect(debutFirstName("ana CLARA souza")).toBe("Ana");
    expect(debutFirstName("Maria Eduarda")).toBe("Maria");
    expect(debutFirstName("D'ÁVILA Costa")).toBe("D'Ávila");
    expect(debutFirstName("ANA-CAROLINA")).toBe("Ana-Carolina");
    expect(debutFirstName("🌸 Ana")).toBe("Ana");
    expect(debutFirstName("🌸")).toBe("você");
    expect(debutFirstName("  ")).toBe("você");
    expect(debutFirstName(null)).toBe("você");
  });
});

describe("debutLetterLayout / debutLetterFontSize", () => {
  it("o corpo desce conforme a carta cresce — pelas linhas que a largura do papel impõe, não só pelas quebras", () => {
    expect(debutLetterFontSize("Bem-vinda.")).toBe(40);
    const layout = debutLetterLayout("Bem-vinda.");
    expect(layout).toEqual({ fontSize: 40, lines: 1, fits: true });
    // Seis parágrafos de 150 caracteres: 6 quebras, mas ~18 linhas no papel.
    const paragrafos = Array.from({ length: 6 }, () => "palavra ".repeat(19).trim()).join("\n");
    const denso = debutLetterLayout(paragrafos);
    expect(denso.fontSize).toBeLessThanOrEqual(29);
    expect(denso.fontSize).toBeGreaterThanOrEqual(22);
    expect(denso.lines).toBeGreaterThan(6);
    expect(denso.fits).toBe(true);
    expect(denso.lines * denso.fontSize * DEBUT_LETTER_GEOMETRY.lineHeight).toBeLessThanOrEqual(DEBUT_LETTER_GEOMETRY.linesHeight);
  });

  it("uma carta que não cabe nem no menor corpo é recusada com a razão; caixa alta conta mais", () => {
    // 12 linhas e < 900 caracteres, mas em caixa alta: cada linha quebra em duas no papel.
    const enorme = Array.from({ length: 12 }, () => "PALAVRA COMPRIDA ".repeat(4).trim()).join("\n");
    expect(enorme.length).toBeLessThan(DEBUT_LETTER_MAX);
    expect(debutLetterLayout(enorme).fits).toBe(false);
    expect(debutLetterProblem(enorme)).toMatch(/não cabe no papel/);
    const minusculas = enorme.toLowerCase();
    expect(debutLetterLayout(minusculas).lines).toBeLessThanOrEqual(debutLetterLayout(enorme).lines);
  });

  it("linhas em branco entre parágrafos custam pouco mais de meia linha", () => {
    const semVazias = debutLetterLayout("a\nb\nc");
    const comVazias = debutLetterLayout("a\n\nb\n\nc");
    expect(comVazias.lines).toBeCloseTo(semVazias.lines + 2 * DEBUT_LETTER_GEOMETRY.blankLine, 5);
  });
});

describe("editionPrintSet", () => {
  it("a carta vai na frente dos cartões; sem carta, só os cartões", () => {
    expect(editionPrintSet({ letter: "carta", cards: ["a", "b"] })).toEqual(["carta", "a", "b"]);
    expect(editionPrintSet({ letter: null, cards: ["a"] })).toEqual(["a"]);
  });
});
