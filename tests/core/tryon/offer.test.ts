// "Me vê com ela" (core, puro): a oferta da Lia. Quem decide se oferece é o
// código; a pergunta tocável diz o que é, que é IA e o que acontece com a
// foto ANTES do toque; os ids cabem na Z-API; o toque vira texto com
// contexto no histórico; a lista da prévia não se confunde com o catálogo.
import { describe, expect, it } from "vitest";

import { buildBotSystemPrompt } from "@/core/bot/prompt";
import {
  isTryOnOfferBody,
  offerRefusalText,
  parseTryOnRowId,
  shouldOfferTryOn,
  TRYON_OFFER_TIMING,
  tryOnAnswerAckText,
  tryOnAnswerHistoryText,
  tryOnOfferBody,
  tryOnOfferOptions,
  tryOnRowId,
} from "@/core/tryon/offer";
import { historyTextFor, historyTextForOutbound } from "@/services/wa-bot";

const ID = "8b0f7f3e-6a1b-4c2d-9e8f-0123456789ab";
const NOW = new Date("2026-10-13T15:00:00Z");
const base = {
  enabled: true,
  mediaEnabled: true,
  wearable: true,
  hasGarmentPhoto: true,
  inStock: true,
  colorInStock: true,
  inFlight: false,
  quotaOk: true,
  lastOfferAt: null,
  lastDeclinedAt: null,
  now: NOW,
};

describe("a pergunta tocável", () => {
  it("ids e títulos cabem na Z-API (id ≤ 64, título ≤ 24) e voltam pelo parse", () => {
    for (const option of tryOnOfferOptions(ID)) {
      expect(option.id.length).toBeLessThanOrEqual(64);
      expect(option.title.length).toBeLessThanOrEqual(24);
    }
    expect(parseTryOnRowId(tryOnRowId("quero", ID))).toEqual({ answer: "quero", requestId: ID });
    expect(parseTryOnRowId(tryOnRowId("agora_nao", ID))).toEqual({ answer: "agora_nao", requestId: ID });
    expect(parseTryOnRowId(`tryon:talvez:${ID}`)).toBeNull();
    expect(parseTryOnRowId(`tryon:quero:${ID}:extra`)).toBeNull();
    expect(parseTryOnRowId("tryon:quero:nao-e-uuid")).toBeNull();
    expect(parseTryOnRowId(`look:sim:${ID}`)).toBeNull();
    // O toque é o consentimento: a condição está na própria linha.
    expect(tryOnOfferOptions(ID)[0]!.description).toContain("18 anos");
  });

  it("o texto diz que é IA e que a foto não fica guardada — e pede o TOQUE antes da foto", () => {
    for (const withPhoto of [true, false]) {
      const body = tryOnOfferBody("VESTIDO AMORA", withPhoto);
      expect(body).toContain("VESTIDO AMORA");
      expect(body).toContain("prévia feita com IA");
      expect(body).toContain("não fica guardada");
    }
    const noPhoto = tryOnOfferBody("VESTIDO AMORA", false, "ate_coxas");
    expect(noPhoto.indexOf("Quero me ver")).toBeLessThan(noPhoto.indexOf("foto sua"));
    expect(noPhoto).toContain("corpo inteiro");
    expect(tryOnOfferBody("BLUSA MAELLE", false, "ate_cintura")).toContain("da cintura pra cima");
    expect(tryOnOfferBody("VESTIDO AMORA", true)).toContain("nessa sua foto");
  });

  it("no histórico, a lista da prévia tem marcador próprio (não é 'catálogo enviado')", () => {
    const persisted = [tryOnOfferBody("VESTIDO AMORA", false), ...tryOnOfferOptions(ID).map((o) => `• ${o.title} — ${o.description}`)].join("\n");
    expect(isTryOnOfferBody(persisted)).toBe(true);
    expect(historyTextFor("option_list", persisted)).toContain("Quer se ver com ela?");
    expect(historyTextFor("option_list", persisted)).not.toContain("catálogo");
    expect(isTryOnOfferBody("Toque abaixo\n• VESTIDO AMORA — R$ 189,90")).toBe(false);
    // A pergunta que NÃO chegou (falhou) não pode parecer enviada: senão a Lia acha que ela recebeu.
    expect(historyTextForOutbound({ kind: "option_list", body: persisted, dedupeKey: "wa.bot_media:x:0", templateKey: null, status: "failed" })).toContain("NÃO chegou");
    expect(tryOnAnswerHistoryText("quero", "VESTIDO AMORA")).toBe('[resposta à pergunta "Quer se ver com ela?" (VESTIDO AMORA)]: Quero me ver');
  });

  it("as respostas ao toque: com a foto, já está vestindo; sem, pede a foto certa para a peça", () => {
    expect(tryOnAnswerAckText({ answer: "quero", withPhoto: true, framing: null })).toContain("Tô te vestindo");
    expect(tryOnAnswerAckText({ answer: "quero", withPhoto: false, framing: "ate_coxas" })).toContain("corpo inteiro");
    expect(tryOnAnswerAckText({ answer: "quero", withPhoto: false, framing: "ate_cintura" })).toContain("vestida da cintura pra baixo");
    expect(tryOnAnswerAckText({ answer: "agora_nao", withPhoto: false, framing: null })).toContain("Tudo bem");
  });
});

describe("shouldOfferTryOn", () => {
  it("oferece quando tudo confere", () => {
    expect(shouldOfferTryOn(base)).toEqual({ offer: true });
  });

  it("cada 'nunca', na ordem: desligado, sem visão de foto, não veste, esgotada, cor esgotada, sem foto da peça, em andamento, teto, oferta recente, 'Agora não'", () => {
    expect(shouldOfferTryOn({ ...base, enabled: false, wearable: false })).toEqual({ offer: false, reason: "desligado" });
    expect(shouldOfferTryOn({ ...base, mediaEnabled: false, wearable: false })).toEqual({ offer: false, reason: "midia_desligada" });
    expect(shouldOfferTryOn({ ...base, wearable: false, inStock: false })).toEqual({ offer: false, reason: "nao_veste" });
    expect(shouldOfferTryOn({ ...base, inStock: false, colorInStock: false })).toEqual({ offer: false, reason: "esgotada" });
    expect(shouldOfferTryOn({ ...base, colorInStock: false, hasGarmentPhoto: false })).toEqual({ offer: false, reason: "cor_esgotada" });
    expect(shouldOfferTryOn({ ...base, hasGarmentPhoto: false })).toEqual({ offer: false, reason: "sem_foto_da_peca" });
    expect(shouldOfferTryOn({ ...base, inFlight: true })).toEqual({ offer: false, reason: "em_andamento" });
    expect(shouldOfferTryOn({ ...base, quotaOk: false })).toEqual({ offer: false, reason: "limite" });
    const recent = new Date(NOW.getTime() - 60_000);
    expect(shouldOfferTryOn({ ...base, lastOfferAt: recent })).toEqual({ offer: false, reason: "ja_ofereceu" });
    expect(shouldOfferTryOn({ ...base, lastDeclinedAt: new Date(NOW.getTime() - 10 * 86_400_000) })).toEqual({ offer: false, reason: "recusou" });
  });

  it("passado o intervalo, oferece de novo; se ELA pede, passa por cima da oferta recente e do 'Agora não' — nunca dos tetos", () => {
    expect(shouldOfferTryOn({ ...base, lastOfferAt: new Date(NOW.getTime() - TRYON_OFFER_TIMING.reofferAfterMs - 1) })).toEqual({ offer: true });
    expect(shouldOfferTryOn({ ...base, lastDeclinedAt: new Date(NOW.getTime() - TRYON_OFFER_TIMING.quietAfterDeclineMs - 1) })).toEqual({ offer: true });
    const recent = new Date(NOW.getTime() - 60_000);
    expect(shouldOfferTryOn({ ...base, lastOfferAt: recent, lastDeclinedAt: recent, asked: true })).toEqual({ offer: true });
    expect(shouldOfferTryOn({ ...base, quotaOk: false, asked: true })).toEqual({ offer: false, reason: "limite" });
    // "Não pode" (possível menor ou nudez) ou recusa da IA hoje: nem a pedido dela.
    expect(shouldOfferTryOn({ ...base, blockedToday: true, asked: true })).toEqual({ offer: false, reason: "bloqueada_hoje" });
    for (const reason of ["desligado", "midia_desligada", "nao_veste", "sem_foto_da_peca", "esgotada", "cor_esgotada", "em_andamento", "limite", "bloqueada_hoje", "ja_ofereceu", "recusou"] as const) {
      expect(offerRefusalText(reason)).toMatch(/não ofereça|Não ofereça/);
    }
  });
});

describe("o prompt da Lia", () => {
  const options = { storeName: "TRIVÉ", sellerName: "Lia", extraInstructions: "", siteUrl: "https://trive.example" };
  it("a seção da prévia só entra ligada, e diz: oferecer uma vez, só com o toque, nunca prometer caimento", () => {
    expect(buildBotSystemPrompt(options)).not.toContain("PRÉVIA NA FOTO DELA");
    const prompt = buildBotSystemPrompt({ ...options, tryOnEnabled: true });
    expect(prompt).toContain("PRÉVIA NA FOTO DELA");
    expect(prompt).toContain("oferecer_previa");
    expect(prompt).toContain("vestir_em_mim");
    expect(prompt).toContain("Sem o toque, nunca");
    expect(prompt).toContain('nunca diga "vai servir"');
  });
});
