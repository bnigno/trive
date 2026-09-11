// Mídia da cliente no core: metadados tolerantes, graça do áudio em
// transcrição e o texto que cada mensagem recebida assume no histórico.
import { describe, expect, it } from "vitest";

import {
  AUDIO_PENDING_GRACE_MS,
  historyTextForInbound,
  INBOUND_MEDIA_MARKERS,
  isAudioAwaitingTranscription,
  parseWaMediaMeta,
} from "@/core/whatsapp/media";

describe("parseWaMediaMeta", () => {
  it("aceita nulo, jsonb torto e campos extras sem derrubar o turno", () => {
    expect(parseWaMediaMeta(null)).toEqual({});
    expect(parseWaMediaMeta("x")).toEqual({});
    expect(parseWaMediaMeta({ seconds: "doze" })).toEqual({});
    expect(parseWaMediaMeta({ seconds: 12, extra: true })).toEqual({ seconds: 12, extra: true });
    expect(parseWaMediaMeta({ transcript: { status: "done", chars: 40 } })).toEqual({
      transcript: { status: "done", chars: 40 },
    });
  });
});

describe("isAudioAwaitingTranscription", () => {
  const createdAt = new Date("2026-09-10T12:00:00Z");

  it("só espera enquanto o status é pending e dentro da graça", () => {
    const pending = { transcript: { status: "pending" as const } };
    expect(isAudioAwaitingTranscription(pending, createdAt, new Date(createdAt.getTime() + 1000))).toBe(true);
    expect(
      isAudioAwaitingTranscription(pending, createdAt, new Date(createdAt.getTime() + AUDIO_PENDING_GRACE_MS)),
    ).toBe(false);
  });

  it("áudio sem transcrição enfileirada (toggle desligado) ou já resolvido não segura o turno", () => {
    const now = new Date(createdAt.getTime() + 1000);
    expect(isAudioAwaitingTranscription({}, createdAt, now)).toBe(false);
    expect(isAudioAwaitingTranscription({ transcript: { status: "done" } }, createdAt, now)).toBe(false);
    expect(isAudioAwaitingTranscription({ transcript: { status: "failed" } }, createdAt, now)).toBe(false);
  });
});

describe("historyTextForInbound", () => {
  it("áudio transcrito é apresentado como fala da cliente; sem transcrição, como marcador", () => {
    expect(
      historyTextForInbound({
        kind: "audio",
        body: "quero o vestido dunas no M",
        mediaMeta: { transcript: { status: "done" } },
      }),
    ).toBe("[áudio da cliente, transcrição automática] quero o vestido dunas no M");
    expect(
      historyTextForInbound({
        kind: "audio",
        body: INBOUND_MEDIA_MARKERS.audio,
        mediaMeta: { transcript: { status: "failed" } },
      }),
    ).toBe(`${INBOUND_MEDIA_MARKERS.audio} (não foi possível transcrever)`);
  });

  it("foto anexada avisa o modelo; sem abrir pede para descrever; antiga pede para não inventar", () => {
    const body = `${INBOUND_MEDIA_MARKERS.image} tem igual?`;
    expect(historyTextForInbound({ kind: "image", body, mediaMeta: {}, image: "attached" })).toBe(
      `${body} (a foto está anexada nesta mensagem)`,
    );
    expect(historyTextForInbound({ kind: "image", body, mediaMeta: {}, image: "unavailable" })).toBe(
      `${body} (não foi possível abrir a foto — peça para ela descrever a peça ou reenviar)`,
    );
    expect(historyTextForInbound({ kind: "image", body, mediaMeta: {}, image: "old" })).toBe(
      `${body} (foto antiga, não anexada — não descreva o que havia nela)`,
    );
    expect(historyTextForInbound({ kind: "image", body, mediaMeta: {} })).toBe(
      `${body} (foto antiga, não anexada — não descreva o que havia nela)`,
    );
  });

  it("texto comum passa intacto", () => {
    expect(historyTextForInbound({ kind: "text", body: "oi", mediaMeta: {} })).toBe("oi");
  });
});
