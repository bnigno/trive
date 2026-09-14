import { describe, expect, it } from "vitest";

import {
  FOLLOWUP_GRACE_MINUTES,
  followupMemoryLine,
  followupWhenLabel,
  isFollowupSuperseded,
  isFollowupTooLate,
  isReturnRequest,
  askedToCallBack,
  looksLikeConsent,
  planFollowup,
  renderFollowupPrompt,
} from "@/core/bot/followup";
import { DEFAULT_SEND_WINDOW } from "@/core/whatsapp/send-window";
import { spDateTime, spTimeLabel } from "@/lib/sp-day";

// Segunda 2026-09-14, 15:00 em São Paulo (18:00Z).
const NOW = new Date("2026-09-14T18:00:00Z");
const window = DEFAULT_SEND_WINDOW;

describe("planFollowup", () => {
  it("data + hora de SP viram o instante certo; fora da janela ajusta; passado, perto e longe recusam", () => {
    const ok = planFollowup({ date: "2026-09-15", time: "10:00", now: NOW, window });
    expect(ok).toEqual({ ok: true, dueAt: new Date("2026-09-15T13:00:00Z"), adjusted: null });
    expect(planFollowup({ date: "2026-09-15", time: "07:30", now: NOW, window })).toEqual({ ok: true, dueAt: new Date("2026-09-15T12:00:00Z"), adjusted: "janela_inicio" });
    expect(planFollowup({ date: "2026-09-15", time: "22:00", now: NOW, window })).toEqual({ ok: true, dueAt: new Date("2026-09-16T12:00:00Z"), adjusted: "dia_seguinte" });
    expect(planFollowup({ date: "2026-09-14", time: "21:00", now: NOW, window })).toMatchObject({ ok: true, adjusted: "dia_seguinte" });
    expect(planFollowup({ date: "2026-09-14", time: "14:00", now: NOW, window })).toEqual({ ok: false, reason: "passado" });
    expect(planFollowup({ date: "2026-09-14", time: "15:10", now: NOW, window })).toEqual({ ok: false, reason: "muito_perto" });
    expect(planFollowup({ date: "2026-09-14", time: "15:30", now: NOW, window })).toMatchObject({ ok: true });
    expect(planFollowup({ date: "2026-09-22", time: "10:00", now: NOW, window })).toEqual({ ok: false, reason: "muito_longe" });
    expect(planFollowup({ date: "2026-09-21", time: "14:00", now: NOW, window })).toMatchObject({ ok: true });
    expect(planFollowup({ date: "15/09/2026", time: "10:00", now: NOW, window })).toEqual({ ok: false, reason: "data_invalida" });
    expect(planFollowup({ date: "2026-02-31", time: "10:00", now: NOW, window })).toEqual({ ok: false, reason: "data_invalida" });
    expect(planFollowup({ date: "2026-13-01", time: "10:00", now: NOW, window })).toEqual({ ok: false, reason: "data_invalida" });
    expect(planFollowup({ date: "2026-09-15", time: "10h", now: NOW, window })).toEqual({ ok: false, reason: "hora_invalida" });
    expect(planFollowup({ date: "2026-09-15", time: "25:00", now: NOW, window })).toEqual({ ok: false, reason: "hora_invalida" });
  });

  it("o rótulo é no relógio de SP", () => {
    expect(followupWhenLabel(new Date("2026-09-15T13:00:00Z"))).toBe("terça-feira, 15 de setembro às 10:00");
    expect(spTimeLabel(spDateTime("2026-09-15", 9 * 60 + 5))).toBe("09:05");
  });
});

describe("looksLikeConsent", () => {
  it("reconhece o sim e recusa o não", () => {
    for (const yes of ["sim", "Sim, pode", "pode ser", "claro!", "ok", "tá bom", "beleza", "combinado", "às 10 tá ótimo", "pode sim", "S", "vamos", "fechou", "às 10 então"]) {
      expect(looksLikeConsent(yes), yes).toBe(true);
    }
    for (const no of ["não", "não precisa", "deixa", "nem", "amanhã eu vejo", "vou pensar", "hoje não", "obrigada", "não me chama", "ok mas não me chama", "claro que não", "quero pensar mais", "manda a foto do vestido", "certo, vou pensar", "isso mesmo, a azul"]) {
      expect(looksLikeConsent(no), no).toBe(false);
    }
    // Ela mesma pediu: consentimento sem pergunta da Lia.
    for (const request of ["me chama amanhã às 10", "pode me chamar depois", "me liga amanhã", "me avisa quando puder"]) {
      expect(isReturnRequest(request), request).toBe(true);
    }
    for (const notRequest of ["não me chama", "vou pensar", "manda a foto"]) {
      expect(isReturnRequest(notRequest), notRequest).toBe(false);
    }
    expect(askedToCallBack("Posso te chamar amanhã às 10h?")).toBe(true);
    expect(askedToCallBack("Te chamo amanhã às 10, pode ser?")).toBe(true);
    expect(askedToCallBack("Que tal o Longo Dunas em M?")).toBe(false);
    expect(askedToCallBack("Te chamo amanhã então.")).toBe(false);
  });
});

describe("textos e carência", () => {
  it("caderninho, fala sintética e 'superada'", () => {
    const dueAt = new Date("2026-09-15T13:00:00Z");
    expect(followupMemoryLine({ dueAt, reason: "ver se decidiu o Longo Dunas" })).toContain("15 de setembro às 10:00");
    expect(followupMemoryLine({ dueAt, reason: "x" })).toContain("não combine outro");
    expect(renderFollowupPrompt({ kind: "customer", reason: "ver se decidiu", dueAt })).toContain("ela pediu que você a chamasse em terça-feira, 15 de setembro às 10:00");
    expect(renderFollowupPrompt({ kind: "idle_cart", reason: "sacola parada", dueAt })).toContain("retomada automática");
    const createdAt = NOW;
    expect(isFollowupSuperseded({ createdAt, lastInboundAt: null })).toBe(false);
    expect(isFollowupSuperseded({ createdAt, lastInboundAt: new Date(NOW.getTime() + (FOLLOWUP_GRACE_MINUTES - 1) * 60_000) })).toBe(false);
    expect(isFollowupSuperseded({ createdAt, lastInboundAt: new Date(NOW.getTime() + (FOLLOWUP_GRACE_MINUTES + 1) * 60_000) })).toBe(true);
    expect(isFollowupTooLate({ dueAt, now: new Date(dueAt.getTime() + 5 * 3_600_000) })).toBe(false);
    expect(isFollowupTooLate({ dueAt, now: new Date(dueAt.getTime() + 7 * 3_600_000) })).toBe(true);
  });
});
