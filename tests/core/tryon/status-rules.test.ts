// "Me vê com ela" (core, puro): os estados do pedido de prévia, as peças que
// dá para vestir, a foto que cada uma pede, os tetos do dia e o que a
// cliente lê — a legenda sempre avisa que é IA e que não prova tamanho, e
// nenhum texto acusa a cliente.
import { describe, expect, it } from "vitest";

import { PIECE_TYPES } from "@/core/catalog/piece-types";
import {
  failureText,
  isTryOnWearable,
  photoProblemText,
  quotaText,
  requiredFraming,
  staleNoticeText,
  TRYON_FAILURE_REASONS,
  TRYON_PHOTO_PROBLEMS,
  tryOnCaption,
  tryOnCategoryFor,
  tryOnQuotaVerdict,
} from "@/core/tryon/rules";
import {
  assertTryOnTransition,
  canTransitionTryOn,
  InvalidTryOnTransitionError,
  isTryOnClosed,
  isTryOnInFlight,
  isTryOnStatus,
  TRYON_STATUSES,
  TRYON_TRANSITIONS,
} from "@/core/tryon/status";
import { TRYON_REQUEST_STATUSES } from "@/db/schema/tryon";

describe("estados da prévia", () => {
  it("o banco e o core têm a mesma lista de estados", () => {
    expect([...TRYON_REQUEST_STATUSES]).toEqual([...TRYON_STATUSES]);
    for (const status of TRYON_STATUSES) expect(isTryOnStatus(status)).toBe(true);
    expect(isTryOnStatus("done")).toBe(false);
  });

  it("o caminho feliz e a volta à fila são permitidos; encerrado não muda mais", () => {
    expect(canTransitionTryOn("offered", "awaiting_photo")).toBe(true);
    expect(canTransitionTryOn("awaiting_photo", "queued")).toBe(true);
    expect(canTransitionTryOn("queued", "submitting")).toBe(true);
    expect(canTransitionTryOn("submitting", "processing")).toBe(true);
    expect(canTransitionTryOn("processing", "sent")).toBe(true);
    // 429 na entrada (nada cobrado) e prévia infiel com tentativa sobrando.
    expect(canTransitionTryOn("submitting", "queued")).toBe(true);
    expect(canTransitionTryOn("processing", "queued")).toBe(true);
    // Mudou de ideia na mesma lista: volta pelo toque (que grava o consentimento de novo), nunca direto para a fila.
    expect(canTransitionTryOn("declined", "awaiting_photo")).toBe(true);
    expect(canTransitionTryOn("declined", "queued")).toBe(false);
    for (const closed of ["sent", "photo_rejected", "failed"] as const) {
      expect(TRYON_TRANSITIONS[closed]).toEqual([]);
      expect(isTryOnClosed(closed)).toBe(true);
    }
    // Nunca pula a fila nem volta a pedir à FASHN sem passar por "enviando".
    expect(canTransitionTryOn("offered", "submitting")).toBe(false);
    expect(canTransitionTryOn("queued", "processing")).toBe(false);
    expect(() => assertTryOnTransition("sent", "queued")).toThrow(InvalidTryOnTransitionError);
    expect(isTryOnInFlight("processing")).toBe(true);
    expect(isTryOnInFlight("awaiting_photo")).toBe(false);
  });
});

describe("regras da prévia", () => {
  it("só roupa vira prévia; blusa pede da cintura para cima, o resto até as coxas", () => {
    expect(tryOnCategoryFor("vestido")).toBe("one-pieces");
    expect(tryOnCategoryFor("blusa")).toBe("tops");
    expect(tryOnCategoryFor("saia")).toBe("bottoms");
    for (const accessory of ["bolsa", "brinco", "oculos", "outro"] as const) expect(isTryOnWearable(accessory)).toBe(false);
    expect(isTryOnWearable(null)).toBe(false);
    for (const type of PIECE_TYPES) {
      const category = tryOnCategoryFor(type.slug);
      if (category) expect(["ate_coxas", "ate_cintura"]).toContain(requiredFraming(category));
    }
    expect(requiredFraming("tops")).toBe("ate_cintura");
    expect(requiredFraming("one-pieces")).toBe("ate_coxas");
    expect(requiredFraming("bottoms")).toBe("ate_coxas");
  });

  it("tetos do dia: o da loja vale antes do da cliente", () => {
    const base = { perCustomerDaily: 2, dailyTotal: 20 };
    expect(tryOnQuotaVerdict({ ...base, customerToday: 1, totalToday: 5 })).toEqual({ ok: true });
    expect(tryOnQuotaVerdict({ ...base, customerToday: 2, totalToday: 5 })).toEqual({ ok: false, reason: "limite_cliente" });
    expect(tryOnQuotaVerdict({ ...base, customerToday: 2, totalToday: 20 })).toEqual({ ok: false, reason: "limite_loja" });
  });

  it("a legenda diz que é IA e que o tamanho se confere — sempre", () => {
    const caption = tryOnCaption("VESTIDO AMORA");
    expect(caption).toContain("VESTIDO AMORA");
    expect(caption).toContain("prévia feita com IA");
    expect(caption).toContain("o tamanho certinho a gente confere");
  });

  it("nenhum texto acusa a cliente (idade, nudez, corpo) e todos têm conteúdo", () => {
    const accusing = /menor|idade|nua|nudez|corpo dela|gord|magr|feio/i;
    for (const problem of TRYON_PHOTO_PROBLEMS) {
      for (const framing of ["ate_coxas", "ate_cintura"] as const) {
        const text = photoProblemText(problem, { productName: "BLUSA MAELLE", framing });
        expect(text.length).toBeGreaterThan(20);
        expect(text).not.toMatch(accusing);
      }
    }
    for (const reason of TRYON_FAILURE_REASONS) {
      expect(failureText(reason).length).toBeGreaterThan(20);
      expect(failureText(reason)).not.toMatch(accusing);
    }
    expect(photoProblemText("enquadramento", { productName: "VESTIDO AMORA", framing: "ate_coxas" })).toContain("corpo inteiro");
    expect(photoProblemText("enquadramento", { productName: "BLUSA MAELLE", framing: "ate_cintura" })).toContain("cintura pra cima");
    expect(photoProblemText("parte_de_baixo", { productName: "BLUSA MAELLE", framing: "ate_cintura" })).toContain("vestida da cintura pra baixo");
    // Menor de idade e nudez caem no MESMO texto neutro — e ele não convida a mandar outra foto.
    const naoPode = photoProblemText("nao_pode", { productName: "X", framing: "ate_coxas" });
    expect(naoPode).toContain("não consigo usar");
    expect(naoPode).not.toMatch(/manda|outra foto/i);
    expect(quotaText("limite_cliente", 2)).toContain("2 prévias");
    expect(quotaText("limite_loja", 2)).toContain("acabaram");
    // Teto de fotos recusadas: nunca diz "já fizemos as suas prévias" a quem não recebeu nenhuma.
    expect(quotaText("limite_fotos", 2)).not.toContain("prévias");
    expect(staleNoticeText("VESTIDO AMORA")).toContain("VESTIDO AMORA");
    expect(failureText("visao_recusou")).not.toMatch(/manda|outra foto/i);
  });
});
