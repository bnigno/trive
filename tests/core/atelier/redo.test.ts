import { describe, expect, it } from "vitest";

import { REDO_BLOCKED_LABELS, canRedoIntake, roundSuffix } from "@/core/atelier/redo";

const base = { status: "failed", movements: 0, hasLiveEvent: false, productStatus: null };

describe("canRedoIntake", () => {
  it("refaz o que falhou ou virou rascunho sem estoque; nunca com montagem viva, estoque lançado ou peça na vitrine", () => {
    expect(canRedoIntake(base)).toEqual({ ok: true });
    expect(canRedoIntake({ ...base, status: "done", productStatus: "draft" })).toEqual({ ok: true });
    // 'queued' sem evento vivo (a função morreu no meio): pode refazer.
    expect(canRedoIntake({ ...base, status: "queued" })).toEqual({ ok: true });
    expect(canRedoIntake({ ...base, status: "queued", hasLiveEvent: true })).toEqual({ ok: false, reason: "em_andamento" });
    expect(canRedoIntake({ ...base, status: "failed", hasLiveEvent: true })).toEqual({ ok: false, reason: "em_andamento" });
    expect(canRedoIntake({ ...base, status: "done", movements: 8 })).toEqual({ ok: false, reason: "estoque_lancado" });
    expect(canRedoIntake({ ...base, status: "done", productStatus: "active" })).toEqual({ ok: false, reason: "peca_ativa" });
    expect(canRedoIntake({ ...base, status: "done", payableStatus: "settled" })).toEqual({ ok: false, reason: "conta_paga" });
    expect(canRedoIntake({ ...base, status: "done", payableStatus: "pending" })).toEqual({ ok: true });
    expect(REDO_BLOCKED_LABELS.estoque_lancado).toContain("estoque");
    expect(REDO_BLOCKED_LABELS.peca_ativa).toContain("vitrine");
  });

  it("a rodada entra nas chaves de dedupe: a primeira sem sufixo, as seguintes com :rN", () => {
    expect(roundSuffix(0)).toBe("");
    expect(roundSuffix(2)).toBe(":r2");
  });
});
