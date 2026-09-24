// "A peça se mexe": custo do vídeo por duração × resolução, o texto de
// movimento (nunca muda a peça; gira só quando há costas) e o teto checado
// antes de gastar.
import { describe, expect, it } from "vitest";

import { FASHN_VIDEO_CREDITS, VIDEO_DURATIONS, VIDEO_RESOLUTIONS, creditsToUsdCents, videoCreditsFor } from "@/core/studio/cost";
import { buildVideoMotionPrompt, VIDEO_AI_NOTICE, VIDEO_DEFAULTS, videoFitsBudget } from "@/core/studio/video";

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
    expect(prompt).not.toMatch(/back/i);
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
