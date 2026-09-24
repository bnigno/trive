import { describe, expect, it } from "vitest";

import {
  canTransitionInterview,
  classifyInterviewReply,
  fallbackInterviewDraft,
  interviewCadence,
  interviewSourcesFor,
  INTERVIEW_ANSWER_WINDOW_MS,
  INTERVIEW_DRAFT_WINDOW_MS,
  INTERVIEW_PRODUCT_COOLDOWN_MS,
  isInterviewOpen,
  normalizeInterviewDraft,
  normalizeInterviewHour,
  pickInterviewTarget,
  questionKeysFor,
  shouldAskNow,
  type InterviewCandidate,
} from "@/core/atelier/interview";

const NOW = new Date("2026-10-05T13:00:00.000Z");

function candidate(over: Partial<InterviewCandidate> & { productId: string }): InterviewCandidate {
  return {
    name: `Peça ${over.productId}`,
    pieceType: "vestido",
    hasNote: false,
    inActiveEdition: false,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    askedKeys: [],
    lastAskedAt: null,
    ...over,
  };
}

describe("pickInterviewTarget", () => {
  it("a edição da cidade sem a voz da dona vem primeiro, depois as outras sem nota, depois as com nota", () => {
    const target = pickInterviewTarget(
      [
        candidate({ productId: "com-nota", hasNote: true, createdAt: new Date("2026-09-30T00:00:00Z") }),
        candidate({ productId: "sem-nota", createdAt: new Date("2026-09-29T00:00:00Z") }),
        candidate({ productId: "cirio", inActiveEdition: true, createdAt: new Date("2026-09-02T00:00:00Z") }),
      ],
      NOW,
    );
    expect(target?.productId).toBe("cirio");
    expect(target?.questionKey).toBe("por_que");
  });

  it("dentro do mesmo grupo, a peça mais nova", () => {
    const target = pickInterviewTarget(
      [candidate({ productId: "velha", createdAt: new Date("2026-09-01T00:00:00Z") }), candidate({ productId: "nova", createdAt: new Date("2026-09-20T00:00:00Z") })],
      NOW,
    );
    expect(target?.productId).toBe("nova");
  });

  it("peça perguntada há menos de 14 dias fica de fora; depois volta com a próxima pergunta", () => {
    const recent = candidate({ productId: "a", askedKeys: ["por_que"], lastAskedAt: new Date(NOW.getTime() - 60_000) });
    expect(pickInterviewTarget([recent], NOW)).toBeNull();
    const later = { ...recent, lastAskedAt: new Date(NOW.getTime() - INTERVIEW_PRODUCT_COOLDOWN_MS) };
    expect(pickInterviewTarget([later], NOW)).toMatchObject({ productId: "a", questionKey: "onde_usar" });
  });

  it("acessório não ganha pergunta de caimento; esgotadas as perguntas, a peça sai da fila", () => {
    expect(questionKeysFor("bolsa")).toEqual(["por_que", "onde_usar", "combina"]);
    expect(questionKeysFor("vestido")).toContain("caimento");
    expect(questionKeysFor(null)).toContain("caimento");
    const done = candidate({ productId: "b", pieceType: "bolsa", askedKeys: ["por_que", "onde_usar", "combina"] });
    expect(pickInterviewTarget([done], NOW)).toBeNull();
  });

  it("a pergunta leva o nome da peça", () => {
    expect(pickInterviewTarget([candidate({ productId: "x", name: "Longo Dunas " })], NOW)?.question).toBe(
      "Por que você escolheu trazer Longo Dunas para a loja?",
    );
  });
});

describe("interviewCadence", () => {
  it("três seguidas sem resposta (pulou ou venceu) → semanal", () => {
    expect(interviewCadence([{ status: "skipped" }, { status: "expired" }, { status: "skipped" }])).toEqual({ mode: "weekly" });
  });

  it("uma aprovada no meio zera a conta; falha da inteligência não conta", () => {
    expect(interviewCadence([{ status: "skipped" }, { status: "expired" }, { status: "approved" }, { status: "skipped" }])).toEqual({ mode: "daily" });
    expect(interviewCadence([{ status: "skipped" }, { status: "failed" }, { status: "expired" }])).toEqual({ mode: "daily" });
    expect(interviewCadence([{ status: "skipped" }, { status: "failed" }, { status: "expired" }, { status: "expired" }])).toEqual({ mode: "weekly" });
  });

  it("a aberta não entra na conta", () => {
    expect(interviewCadence([{ status: "asked" }, { status: "skipped" }, { status: "skipped" }])).toEqual({ mode: "daily" });
  });
});

describe("shouldAskNow", () => {
  const base = { enabled: true, hour: 10, weekends: false, spHour: 10, spWeekday: 3, cadence: { mode: "daily" as const } };
  it("só na hora escolhida, ligada", () => {
    expect(shouldAskNow(base)).toBe(true);
    expect(shouldAskNow({ ...base, spHour: 11 })).toBe(false);
    expect(shouldAskNow({ ...base, enabled: false })).toBe(false);
  });
  it("fim de semana só com o sim dela", () => {
    expect(shouldAskNow({ ...base, spWeekday: 6 })).toBe(false);
    expect(shouldAskNow({ ...base, spWeekday: 0, weekends: true })).toBe(true);
  });
  it("no modo semanal, só às segundas", () => {
    expect(shouldAskNow({ ...base, cadence: { mode: "weekly" } })).toBe(false);
    expect(shouldAskNow({ ...base, spWeekday: 1, cadence: { mode: "weekly" } })).toBe(true);
  });
  it("hora fora de 9–20 volta às 10", () => {
    expect(normalizeInterviewHour(8)).toBe(10);
    expect(normalizeInterviewHour("14")).toBe(14);
    expect(normalizeInterviewHour(undefined)).toBe(10);
  });
});

describe("classifyInterviewReply", () => {
  it("áudio responde à pergunta e ao rascunho (reescreve); foto nunca", () => {
    expect(classifyInterviewReply({ status: "asked", messageKind: "audio", body: "" })).toEqual({ kind: "answer_audio" });
    expect(classifyInterviewReply({ status: "draft_sent", messageKind: "audio", body: "" })).toEqual({ kind: "answer_audio" });
    expect(classifyInterviewReply({ status: "asked", messageKind: "image", body: "pula" })).toBeNull();
    expect(classifyInterviewReply({ status: "drafting", messageKind: "audio", body: "" })).toBeNull();
  });

  it("texto só com as palavras combinadas — texto solto continua indo à Lia", () => {
    expect(classifyInterviewReply({ status: "asked", messageKind: "text", body: "tem esse vestido no M?" })).toBeNull();
    expect(classifyInterviewReply({ status: "asked", messageKind: "text", body: "Resposta: trouxe porque é fresco" })).toEqual({
      kind: "answer_text",
      text: "trouxe porque é fresco",
    });
    expect(classifyInterviewReply({ status: "asked", messageKind: "text", body: "resposta:" })).toBeNull();
    expect(classifyInterviewReply({ status: "asked", messageKind: "text", body: "Pula!" })).toEqual({ kind: "skip" });
    expect(classifyInterviewReply({ status: "asked", messageKind: "text", body: "amanhã" })).toEqual({ kind: "skip" });
  });

  it("ok / ok voz / corrige só valem com o rascunho na mão", () => {
    expect(classifyInterviewReply({ status: "asked", messageKind: "text", body: "ok" })).toBeNull();
    expect(classifyInterviewReply({ status: "draft_sent", messageKind: "text", body: "OK" })).toEqual({ kind: "approve", withVoice: false });
    expect(classifyInterviewReply({ status: "draft_sent", messageKind: "text", body: "ok voz" })).toEqual({ kind: "approve", withVoice: true });
    expect(classifyInterviewReply({ status: "draft_sent", messageKind: "text", body: "Corrige: é linho puro." })).toEqual({
      kind: "correct",
      text: "é linho puro.",
    });
  });
});

describe("isInterviewOpen", () => {
  const askedAt = new Date(NOW.getTime() - INTERVIEW_ANSWER_WINDOW_MS);
  it("pergunta vale 8 h; rascunho vale 24 h desde o envio", () => {
    expect(isInterviewOpen({ status: "asked", askedAt, draftSentAt: null }, NOW)).toBe(true);
    expect(isInterviewOpen({ status: "asked", askedAt: new Date(askedAt.getTime() - 1), draftSentAt: null }, NOW)).toBe(false);
    const draftSentAt = new Date(NOW.getTime() - INTERVIEW_DRAFT_WINDOW_MS);
    expect(isInterviewOpen({ status: "draft_sent", askedAt: new Date(0), draftSentAt }, NOW)).toBe(true);
    expect(isInterviewOpen({ status: "approved", askedAt: NOW, draftSentAt: NOW }, NOW)).toBe(false);
  });
});

describe("rascunho", () => {
  it("normaliza a resposta do modelo: sem hashtag, legendas iguais viram uma", () => {
    expect(normalizeInterviewDraft({ nota: "  Trouxe porque é fresco.  ", legenda_1: "Fresco #belem", legenda_2: "Fresco" })).toEqual({
      note: "Trouxe porque é fresco.",
      captions: ["Fresco"],
    });
  });
  it("formato errado lança (o chamador cai na fala)", () => {
    expect(() => normalizeInterviewDraft({ nota: 3 })).toThrow();
    expect(() => normalizeInterviewDraft({ nota: "…", legenda_1: "", legenda_2: "" })).toThrow();
  });
  it("sem a inteligência, a fala vira a nota", () => {
    expect(fallbackInterviewDraft("trouxe porque é fresco")).toEqual({ note: "trouxe porque é fresco", captions: [] });
    expect(fallbackInterviewDraft("...")).toBeNull();
  });
});

describe("máquina de estados", () => {
  it("aprovada é final; rascunho pode voltar a ser escrito com um áudio novo", () => {
    expect(canTransitionInterview("draft_sent", "approved")).toBe(true);
    expect(canTransitionInterview("draft_sent", "drafting")).toBe(true);
    expect(canTransitionInterview("approved", "drafting")).toBe(false);
    expect(canTransitionInterview("asked", "approved")).toBe(false);
    expect(interviewSourcesFor("expired").sort()).toEqual(["asked", "draft_sent", "drafting"]);
  });
});
