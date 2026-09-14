import { describe, expect, it } from "vitest";

import { REDO_BLOCKED_LABELS, canRedoIntake } from "@/core/atelier/redo";

describe("canRedoIntake", () => {
  it("refaz o que falhou ou virou rascunho sem estoque; nunca o que está montando ou já lançou estoque", () => {
    expect(canRedoIntake({ status: "failed", movements: 0 })).toEqual({ ok: true });
    expect(canRedoIntake({ status: "done", movements: 0 })).toEqual({ ok: true });
    expect(canRedoIntake({ status: "queued", movements: 0 })).toEqual({ ok: false, reason: "em_andamento" });
    expect(canRedoIntake({ status: "done", movements: 8 })).toEqual({ ok: false, reason: "estoque_lancado" });
    expect(REDO_BLOCKED_LABELS.estoque_lancado).toContain("estoque");
  });
});
