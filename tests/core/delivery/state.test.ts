// Ciclo da saída e das paradas (puro): transições, quando uma parada pode
// fechar e quando a saída pode encerrar.
import { describe, expect, it } from "vitest";

import {
  assertRunTransition,
  canCloseStop,
  canRunTransition,
  FAILURE_REASON_LABELS,
  FAILURE_REASONS,
  InvalidRunTransitionError,
  isRunOpen,
  runCanFinish,
} from "@/core/delivery/state";

describe("transições da saída", () => {
  it("pronta → na rua ou cancelada; na rua → encerrada ou cancelada; fechada não volta", () => {
    expect(canRunTransition("ready", "en_route")).toBe(true);
    expect(canRunTransition("ready", "canceled")).toBe(true);
    expect(canRunTransition("ready", "finished")).toBe(false);
    expect(canRunTransition("en_route", "finished")).toBe(true);
    expect(canRunTransition("en_route", "canceled")).toBe(true);
    expect(canRunTransition("en_route", "ready")).toBe(false);
    expect(canRunTransition("finished", "en_route")).toBe(false);
    expect(canRunTransition("canceled", "en_route")).toBe(false);
    expect(() => assertRunTransition("finished", "canceled")).toThrow(InvalidRunTransitionError);
    expect(() => assertRunTransition("ready", "en_route")).not.toThrow();
  });

  it("aberta = pronta ou na rua", () => {
    expect(isRunOpen("ready")).toBe(true);
    expect(isRunOpen("en_route")).toBe(true);
    expect(isRunOpen("finished")).toBe(false);
    expect(isRunOpen("canceled")).toBe(false);
  });
});

describe("paradas", () => {
  it("só fecha parada por entregar com a saída na rua", () => {
    expect(canCloseStop("en_route", "pending")).toBe(true);
    expect(canCloseStop("ready", "pending")).toBe(false);
    expect(canCloseStop("en_route", "delivered")).toBe(false);
    expect(canCloseStop("finished", "pending")).toBe(false);
  });

  it("encerra só sem parada por entregar (falha e cancelada contam como fechadas)", () => {
    expect(runCanFinish([{ status: "delivered" }, { status: "failed" }, { status: "canceled" }])).toBe(true);
    expect(runCanFinish([{ status: "delivered" }, { status: "pending" }])).toBe(false);
    expect(runCanFinish([])).toBe(true);
  });

  it("todo motivo de falha tem rótulo", () => {
    for (const reason of FAILURE_REASONS) expect(FAILURE_REASON_LABELS[reason]).toBeTruthy();
  });
});
