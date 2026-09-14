import { describe, expect, it } from "vitest";

import { fitSignal, fitSignalStoreLine } from "@/core/catalog/fit-signal";
import {
  FEEDBACK_ANSWERS,
  FEEDBACK_TITLES,
  feedbackHandledBy,
  feedbackHistoryText,
  feedbackMemoryLine,
  feedbackOptions,
  feedbackRowId,
  parseFeedbackRowId,
} from "@/core/orders/feedback";

const ORDER = "0b16429e-72de-49d4-bd55-c9d4b87df002";

describe("Chegou bem? — lista", () => {
  it("ids ≤ 64 e títulos ≤ 24 (limites da Z-API); parse faz a volta; lixo não passa", () => {
    for (const answer of FEEDBACK_ANSWERS) {
      const id = feedbackRowId(answer, ORDER);
      expect(id.length).toBeLessThanOrEqual(64);
      expect(FEEDBACK_TITLES[answer].length).toBeLessThanOrEqual(24);
      expect(parseFeedbackRowId(id)).toEqual({ answer, orderId: ORDER });
    }
    expect(feedbackOptions(ORDER)).toHaveLength(5);
    expect(parseFeedbackRowId("produto:longo-dunas")).toBeNull();
    expect(parseFeedbackRowId("feedback:otimo:" + ORDER)).toBeNull();
    expect(parseFeedbackRowId("feedback:amei:nao-e-uuid")).toBeNull();
    expect(parseFeedbackRowId("feedback:amei:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBeNull();
    expect(feedbackHistoryText({ answer: "defeito", orderNumber: 3, itemLabel: null, previous: "amei" })).toBe('[resposta ao "Chegou bem?" do pedido #3]: Veio com defeito (antes tinha respondido "Amei")');
    expect(parseFeedbackRowId(undefined)).toBeNull();
  });

  it("defeito e 'falar' vão para a equipe; o resto para a Lia", () => {
    expect(feedbackHandledBy("amei")).toBe("lia");
    expect(feedbackHandledBy("grande")).toBe("lia");
    expect(feedbackHandledBy("pequeno")).toBe("lia");
    expect(feedbackHandledBy("defeito")).toBe("human");
    expect(feedbackHandledBy("falar")).toBe("human");
  });

  it("o toque vira texto com contexto; o caderninho ganha a linha", () => {
    expect(feedbackHistoryText({ answer: "grande", orderNumber: 1042, itemLabel: "Longo Dunas · Areia · M" })).toBe(
      '[resposta ao "Chegou bem?" do pedido #1042 (Longo Dunas · Areia · M)]: Ficou grande',
    );
    expect(feedbackHistoryText({ answer: "amei", orderNumber: 7, itemLabel: null })).toBe('[resposta ao "Chegou bem?" do pedido #7]: Amei');
    expect(feedbackMemoryLine({ orderNumber: 1042, itemLabel: "Longo Dunas · M", answer: "pequeno", dayLabel: "05/09" })).toBe(
      'Pedido #1042 (Longo Dunas · M): respondeu "Ficou pequeno" ao Chegou bem? em 05/09',
    );
  });
});

describe("fitSignal", () => {
  it("abaixo de 3 respostas não afirma; 60% numa direção decide; empate não", () => {
    expect(fitSignal({ amei: 1, grande: 1, pequeno: 0 })).toBeNull();
    expect(fitSignal({ amei: 1, grande: 2, pequeno: 0 })).toBe("veste_grande");
    expect(fitSignal({ amei: 1, grande: 0, pequeno: 2 })).toBe("veste_pequeno");
    expect(fitSignal({ amei: 2, grande: 1, pequeno: 0 })).toBeNull();
    expect(fitSignal({ amei: 0, grande: 2, pequeno: 2 })).toBeNull();
    expect(fitSignal({ amei: 0, grande: 3, pequeno: 3 })).toBeNull();
    expect(fitSignal({ amei: 0, grande: 1, pequeno: 1 }, { min: 2, ratio: 0.5 })).toBeNull();
    expect(fitSignalStoreLine("M", "veste_pequeno")).toContain("um número acima");
    expect(fitSignalStoreLine("G", "veste_grande")).toContain("um número abaixo");
    expect(fitSignalStoreLine("único", "veste_grande")).toBe("Pelas clientes, esta peça tende a vestir grande.");
  });
});
