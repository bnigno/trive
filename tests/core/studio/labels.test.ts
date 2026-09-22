// Rótulos do ensaio (core, puro): a candidata e o pedido em português.
import { describe, expect, it } from "vitest";

import { candidateLabel, failureLabel, requestLabel } from "@/core/studio/labels";

const OK = { mesma_peca: true, cor_ok: true, estampa_ok: true, corte_ok: true, artefatos: [], nota: 9 };

describe("rótulos do ensaio", () => {
  it("candidata: aprovada com a nota, reprovada com o motivo, sem julgamento, falhou, na peça, descartada", () => {
    expect(candidateLabel({ status: "candidate", passed: true, judgment: OK, errorDetail: null, storagePath: "x" })).toEqual({ label: "Aprovada 9/10", tone: "success" });
    expect(candidateLabel({ status: "rejected", passed: false, judgment: { ...OK, cor_ok: false, nota: 4 }, errorDetail: null, storagePath: "x" })).toEqual({ label: "Reprovada: 4/10 — cor", tone: "danger" });
    expect(candidateLabel({ status: "candidate", passed: false, judgment: null, errorDetail: "portao_indisponivel: 529", storagePath: "x" })).toEqual({ label: "Sem julgamento — confira com o olho", tone: "warning" });
    expect(candidateLabel({ status: "failed", passed: false, judgment: null, errorDetail: "no_credits: sem créditos", storagePath: null })).toEqual({ label: "Falhou: sem créditos na FASHN", tone: "danger" });
    expect(candidateLabel({ status: "chosen", passed: true, judgment: OK, errorDetail: null, storagePath: "x" })).toEqual({ label: "Na peça", tone: "success" });
    expect(candidateLabel({ status: "discarded", passed: true, judgment: OK, errorDetail: null, storagePath: "x" })).toEqual({ label: "Descartada", tone: "neutral" });
  });

  it("falha: código conhecido vira frase; desconhecido passa como veio", () => {
    expect(failureLabel("sem_foto_base")).toBe("a foto-base da modelo foi descartada");
    expect(failureLabel("algo estranho")).toBe("algo estranho");
    expect(failureLabel(null)).toBe("motivo desconhecido");
  });

  it("pedido: na fila com a contagem, pronto, falhou", () => {
    expect(requestLabel({ status: "queued", optionsWanted: 3, optionsDone: 1, usdCentsSpent: 11 })).toEqual({ label: "Na fila (1 de 3)", tone: "info" });
    expect(requestLabel({ status: "done", optionsWanted: 3, optionsDone: 3, usdCentsSpent: 33 })).toEqual({ label: "Pronto", tone: "success" });
    expect(requestLabel({ status: "failed", optionsWanted: 1, optionsDone: 1, usdCentsSpent: 0 })).toEqual({ label: "Falhou", tone: "danger" });
  });
});
