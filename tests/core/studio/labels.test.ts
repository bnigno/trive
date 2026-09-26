// Rótulos do ensaio (core, puro): a candidata e o pedido em português.
import { describe, expect, it } from "vitest";

import { candidateLabel, failureLabel, requestLabel, studioSpendLabel, videoLabel } from "@/core/studio/labels";

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

  it("vídeo: cada estado em português; a falha diz se ainda dá para buscar sem pagar", () => {
    expect(videoLabel({ status: "queued", errorDetail: null })).toEqual({ label: "Na fila", tone: "info" });
    expect(videoLabel({ status: "submitting", errorDetail: null })).toEqual({ label: "Enviando à FASHN…", tone: "info" });
    expect(videoLabel({ status: "processing", errorDetail: null })).toEqual({ label: "Fazendo o vídeo… (uns 5 min)", tone: "info" });
    expect(videoLabel({ status: "done", errorDetail: null })).toEqual({ label: "Pronto", tone: "success" });
    expect(videoLabel({ status: "discarded", errorDetail: null })).toEqual({ label: "Descartado", tone: "neutral" });
    expect(videoLabel({ status: "failed", errorDetail: "demorou_demais: 30 min" }).label).toBe(
      "Falhou: a FASHN não entregou em 30 min — dá para buscar de novo por 3 dias, sem pagar",
    );
    expect(videoLabel({ status: "failed", errorDetail: "envio_incerto: rede" }).label).toContain("confira o saldo da FASHN");
    expect(videoLabel({ status: "failed", errorDetail: "no_credits: 402" }).label).toBe("Falhou: sem créditos na FASHN");
    for (const code of ["nao_salvou", "pedido_sumiu", "video_desligado", "sem_envio"]) {
      expect(failureLabel(code)).not.toBe(code);
    }
  });

  it("gasto do estúdio: só fotos como sempre; com vídeo, diz quantos de cada; nada = null", () => {
    expect(studioSpendLabel({ images: 0, videos: 0 })).toBeNull();
    expect(studioSpendLabel({ images: 9, videos: 0 })).toEqual({ what: "fotos no corpo", count: "9" });
    expect(studioSpendLabel({ images: 9, videos: 1 })).toEqual({ what: "fotos e vídeos no corpo", count: "9 fotos · 1 vídeo" });
    expect(studioSpendLabel({ images: 1, videos: 2 })).toEqual({ what: "fotos e vídeos no corpo", count: "1 foto · 2 vídeos" });
    expect(studioSpendLabel({ images: 0, videos: 1 })).toEqual({ what: "vídeos no corpo", count: "1 vídeo" });
  });

  it("pedido: na fila com a contagem, pronto, falhou", () => {
    expect(requestLabel({ status: "queued", optionsWanted: 3, optionsDone: 1, usdCentsSpent: 11 })).toEqual({ label: "Na fila (1 de 3)", tone: "info" });
    expect(requestLabel({ status: "done", optionsWanted: 3, optionsDone: 3, usdCentsSpent: 33 })).toEqual({ label: "Pronto", tone: "success" });
    expect(requestLabel({ status: "failed", optionsWanted: 1, optionsDone: 1, usdCentsSpent: 0 })).toEqual({ label: "Falhou", tone: "danger" });
  });
});
