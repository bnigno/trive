// "A peça se mexe": custo do vídeo por duração × resolução, o texto de
// movimento (nunca muda a peça; gira só quando há costas) e o teto checado
// antes de gastar.
import { describe, expect, it } from "vitest";

import { FASHN_VIDEO_CREDITS, VIDEO_DURATIONS, VIDEO_RESOLUTIONS, creditsToUsdCents, videoCreditsFor } from "@/core/studio/cost";
import { STUDIO_VIDEO_STATUSES as SCHEMA_VIDEO_STATUSES } from "@/db/schema/studio";
import {
  assertVideoTransition,
  buildVideoMotionPrompt,
  canRefetchVideo,
  canTransitionVideo,
  checkVideoRequest,
  classifyVideoFailure,
  InvalidVideoTransitionError,
  isVideoInFlight,
  nextVideoPollAt,
  STUDIO_VIDEO_STATUSES,
  VIDEO_AI_NOTICE,
  VIDEO_CAPTION_NOTICE,
  VIDEO_DEFAULTS,
  VIDEO_TIMING,
  VIDEO_TRANSITIONS,
  videoFitsBudget,
} from "@/core/studio/video";

describe("custo do vídeo", () => {
  it("segue a tabela da FASHN: 5 s = 1/3/6 e 10 s = 2/6/12 créditos", () => {
    expect(videoCreditsFor(5, "480p")).toBe(1);
    expect(videoCreditsFor(5, "720p")).toBe(3);
    expect(videoCreditsFor(5, "1080p")).toBe(6);
    expect(videoCreditsFor(10, "480p")).toBe(2);
    expect(videoCreditsFor(10, "720p")).toBe(6);
    expect(videoCreditsFor(10, "1080p")).toBe(12);
    for (const duration of VIDEO_DURATIONS) {
      for (const resolution of VIDEO_RESOLUTIONS) {
        expect(Number.isInteger(FASHN_VIDEO_CREDITS[duration][resolution])).toBe(true);
      }
    }
  });

  it("o padrão é 5 s em 1080p: 6 créditos, US$ 0,45", () => {
    expect(VIDEO_DEFAULTS).toEqual({ durationSeconds: 5, resolution: "1080p" });
    const credits = videoCreditsFor(VIDEO_DEFAULTS.durationSeconds, VIDEO_DEFAULTS.resolution);
    expect(credits).toBe(6);
    expect(creditsToUsdCents(credits)).toBe(45);
  });
});

describe("buildVideoMotionPrompt", () => {
  it("sem costas: movimento contido e a proibição de mudar a peça", () => {
    const prompt = buildVideoMotionPrompt({ pieceType: "vestido", withBackView: false });
    expect(prompt).toContain("letting the fabric move naturally");
    expect(prompt).toContain("Keep the garment exactly as in the image");
    expect(prompt).toContain("Do not add accessories, text or logos");
    expect(prompt).not.toMatch(/\bback\b/i);
    // A cena e a luz são as da foto (editorial): nada de "celular" ou "luz do dia" que troque o clima.
    expect(prompt).toContain("keeps the scene, background and lighting exactly as in the image");
    expect(prompt).not.toMatch(/smartphone|daylight|smile/i);
  });

  it("com a foto das costas: a modelo gira até o quadro final", () => {
    const prompt = buildVideoMotionPrompt({ pieceType: "vestido", withBackView: true });
    expect(prompt).toContain("ending on the back view");
    expect(prompt).toContain("Keep the garment exactly as in the image");
  });

  it("acessório ganha um gesto que mostra a peça; tipo desconhecido ou nulo cai no padrão", () => {
    expect(buildVideoMotionPrompt({ pieceType: "bolsa", withBackView: false })).toContain("shows the accessory");
    expect(buildVideoMotionPrompt({ pieceType: null, withBackView: false })).toContain("letting the fabric move naturally");
    expect(buildVideoMotionPrompt({ pieceType: "inexistente", withBackView: false })).toContain("letting the fabric move naturally");
  });

  it("um gesto sob medida troca só a frase do movimento: a proibição de mudar a peça fica", () => {
    const prompt = buildVideoMotionPrompt({ pieceType: "vestido", withBackView: false, movement: "  She walks two steps toward the window.  " });
    expect(prompt).toContain("She walks two steps toward the window.");
    expect(prompt).not.toContain("letting the fabric move naturally");
    expect(prompt).toContain("Keep the garment exactly as in the image");
    expect(prompt).toContain("Keep her face and body the same.");
    expect(buildVideoMotionPrompt({ pieceType: "vestido", withBackView: false, movement: "   " })).toContain("letting the fabric move naturally");
  });

  it("o aviso de IA diz que é ilustrativo e feito a partir da peça real", () => {
    expect(VIDEO_AI_NOTICE).toMatch(/ilustrativa/);
    expect(VIDEO_AI_NOTICE).toMatch(/IA/);
  });
});

describe("videoFitsBudget", () => {
  it("cabe quando o custo não passa do teto nem do saldo", () => {
    expect(videoFitsBudget({ durationSeconds: 5, resolution: "1080p", budgetCredits: 6, balanceCredits: 6 })).toEqual({ ok: true, credits: 6 });
  });

  it("o teto vem antes do saldo; saldo desconhecido (null) não bloqueia", () => {
    expect(videoFitsBudget({ durationSeconds: 10, resolution: "1080p", budgetCredits: 6, balanceCredits: 0 })).toEqual({ ok: false, credits: 12, reason: "teto" });
    expect(videoFitsBudget({ durationSeconds: 5, resolution: "1080p", budgetCredits: 6, balanceCredits: 5 })).toEqual({ ok: false, credits: 6, reason: "saldo" });
    expect(videoFitsBudget({ durationSeconds: 5, resolution: "480p", budgetCredits: 1, balanceCredits: null })).toEqual({ ok: true, credits: 1 });
  });
});

describe("estados do vídeo no estúdio", () => {
  it("o core e o banco têm os mesmos estados", () => {
    expect([...STUDIO_VIDEO_STATUSES]).toEqual([...SCHEMA_VIDEO_STATUSES]);
  });

  it("só as transições previstas passam; o resto lança", () => {
    const allowed = new Set(Object.entries(VIDEO_TRANSITIONS).flatMap(([from, tos]) => tos.map((to) => `${from}>${to}`)));
    expect([...allowed].sort()).toEqual(
      [
        "done>discarded",
        "failed>discarded",
        "failed>processing",
        "processing>done",
        "processing>failed",
        "queued>failed",
        "queued>submitting",
        "submitting>failed",
        "submitting>processing",
        "submitting>queued",
      ].sort(),
    );
    for (const from of STUDIO_VIDEO_STATUSES) {
      for (const to of STUDIO_VIDEO_STATUSES) {
        const ok = allowed.has(`${from}>${to}`);
        expect(canTransitionVideo(from, to)).toBe(ok);
        if (ok) expect(() => assertVideoTransition(from, to)).not.toThrow();
        else expect(() => assertVideoTransition(from, to)).toThrow(InvalidVideoTransitionError);
      }
    }
    // Um vídeo pronto nunca volta a ser feito: só "descartar".
    expect(canTransitionVideo("done", "processing")).toBe(false);
    expect(canTransitionVideo("discarded", "processing")).toBe(false);
  });

  it("em andamento = na fila, enviando ou fazendo", () => {
    expect(STUDIO_VIDEO_STATUSES.filter(isVideoInFlight)).toEqual(["queued", "submitting", "processing"]);
  });
});

describe("classifyVideoFailure — nunca pagar duas vezes", () => {
  const noJob = (reason: string, status?: number) => classifyVideoFailure({ reason, status, jobId: null });
  const withJob = (reason: string, status?: number) => classifyVideoFailure({ reason, status, jobId: "job-1" });

  it("sem id (o envio): 429 volta à fila; recusa < 500 ou sem chave fecha sem cobrança; o resto é incerto", () => {
    expect(noJob("rate_limited", 429)).toBe("retry_not_charged");
    expect(noJob("no_credits", 402)).toBe("closed_not_charged");
    expect(noJob("no_key", undefined)).toBe("closed_not_charged");
    expect(noJob("no_key", 401)).toBe("closed_not_charged");
    expect(noJob("rejected", 400)).toBe("closed_not_charged");
    expect(noJob("rejected", 422)).toBe("closed_not_charged");
    expect(noJob("unavailable", 500)).toBe("uncertain_submit");
    expect(noJob("unavailable", 503)).toBe("uncertain_submit");
    expect(noJob("network")).toBe("uncertain_submit");
    expect(noJob("timeout")).toBe("uncertain_submit");
    expect(noJob("invalid_response")).toBe("uncertain_submit");
  });

  it("com id (a espera): 'failed' no status fecha sem cobrança; 404 = pedido sumiu; o resto continua esperando", () => {
    expect(withJob("rejected", undefined)).toBe("closed_not_charged");
    expect(withJob("rejected", 404)).toBe("closed_job_gone");
    expect(withJob("rejected", 408)).toBe("keep_open");
    expect(withJob("timeout")).toBe("keep_open");
    expect(withJob("network")).toBe("keep_open");
    expect(withJob("invalid_response")).toBe("keep_open");
    expect(withJob("rate_limited", 429)).toBe("keep_open");
    expect(withJob("unavailable", 503)).toBe("keep_open");
    expect(withJob("no_key", 401)).toBe("keep_open");
  });
});

describe("nextVideoPollAt", () => {
  const submittedAt = new Date("2026-09-25T12:00:00Z");
  const giveUpAt = new Date(submittedAt.getTime() + VIDEO_TIMING.giveUpAfterMs);

  it("a 1ª espera é 4 min depois do envio; as seguintes, 20 s depois de agora", () => {
    expect(nextVideoPollAt({ submittedAt, giveUpAt, now: new Date(submittedAt.getTime() + 3_000), first: true })).toEqual(
      new Date(submittedAt.getTime() + 240_000),
    );
    const now = new Date(submittedAt.getTime() + 300_000);
    expect(nextVideoPollAt({ submittedAt, giveUpAt, now, first: false })).toEqual(new Date(now.getTime() + 20_000));
    // "1ª" atrasada (a fila demorou): nunca no passado.
    const late = new Date(submittedAt.getTime() + 600_000);
    expect(nextVideoPollAt({ submittedAt, giveUpAt, now: late, first: true })).toEqual(new Date(late.getTime() + 1_500));
  });

  it("passou do prazo de desistir: null", () => {
    expect(nextVideoPollAt({ submittedAt, giveUpAt, now: new Date(giveUpAt.getTime() - 10_000), first: false })).toBeNull();
    expect(nextVideoPollAt({ submittedAt, giveUpAt, now: new Date(giveUpAt.getTime() - 30_000), first: false })).toEqual(
      new Date(giveUpAt.getTime() - 10_000),
    );
  });
});

describe("canRefetchVideo", () => {
  const submittedAt = new Date("2026-09-25T12:00:00Z");
  const base = { vendorJobId: "job-1", submittedAt, updatedAt: submittedAt };
  const at = (ms: number) => new Date(submittedAt.getTime() + ms);

  it("falha que ainda tem vídeo (demorou, não salvou), dentro dos 3 dias: sim", () => {
    expect(canRefetchVideo({ ...base, status: "failed", errorDetail: "demorou_demais: x" }, at(3_600_000))).toBe(true);
    expect(canRefetchVideo({ ...base, status: "failed", errorDetail: "nao_salvou" }, at(3_600_000))).toBe(true);
    expect(canRefetchVideo({ ...base, status: "failed", errorDetail: "nao_salvou" }, at(VIDEO_TIMING.refetchWindowMs))).toBe(false);
  });

  it("sem id, falha sem vídeo, pronto ou descartado: não", () => {
    expect(canRefetchVideo({ ...base, vendorJobId: null, status: "failed", errorDetail: "envio_incerto" }, at(60_000))).toBe(false);
    expect(canRefetchVideo({ ...base, status: "failed", errorDetail: "rejected: x" }, at(60_000))).toBe(false);
    expect(canRefetchVideo({ ...base, status: "failed", errorDetail: "pedido_sumiu" }, at(60_000))).toBe(false);
    expect(canRefetchVideo({ ...base, status: "done", errorDetail: null }, at(60_000))).toBe(false);
    expect(canRefetchVideo({ ...base, status: "discarded", errorDetail: null }, at(60_000))).toBe(false);
  });

  it("fazendo e parado há mais de 10 min: libera; ainda andando: não", () => {
    expect(canRefetchVideo({ ...base, status: "processing", errorDetail: null, updatedAt: at(0) }, at(VIDEO_TIMING.stallMs + 1))).toBe(true);
    expect(canRefetchVideo({ ...base, status: "processing", errorDetail: null, updatedAt: at(0) }, at(VIDEO_TIMING.stallMs))).toBe(false);
  });
});

describe("checkVideoRequest", () => {
  it("teto de vídeos do dia vem antes do saldo; saldo desconhecido não bloqueia", () => {
    expect(checkVideoRequest({ dailyLimit: 2, usedToday: 1, credits: 6, balanceCredits: 6 })).toEqual({ ok: true });
    expect(checkVideoRequest({ dailyLimit: 2, usedToday: 2, credits: 6, balanceCredits: 100 })).toEqual({ ok: false, reason: "teto" });
    expect(checkVideoRequest({ dailyLimit: 2, usedToday: 0, credits: 6, balanceCredits: 5 })).toEqual({ ok: false, reason: "saldo" });
    expect(checkVideoRequest({ dailyLimit: 2, usedToday: 0, credits: 6, balanceCredits: null })).toEqual({ ok: true });
  });

  it("o aviso da legenda é a mesma ideia do aviso curto", () => {
    expect(VIDEO_CAPTION_NOTICE.toLowerCase()).toContain(VIDEO_AI_NOTICE.toLowerCase());
  });
});
