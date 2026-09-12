// Desenho real da carta de estreia: PNG 1080×720, sem rede, carta curta,
// carta de 12 linhas no teto, e emoji no nome sem derrubar.
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEBUT_LETTER_MAX, DEBUT_LETTER_MAX_LINES, debutLetterLayout, debutLetterProblem, normalizeDebutLetter } from "@/core/edition/debut";
import type { DebutLetterData } from "@/core/edition/types";
import { loadReceiptAssets } from "@/receipts/assets";
import { DEBUT_LETTER_HEIGHT, DEBUT_LETTER_WIDTH, renderDebutLetterPng } from "@/receipts/render-debut-letter";

const originalFetch = globalThis.fetch;
const networkCalls: string[] = [];

beforeEach(() => {
  networkCalls.length = 0;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (/^https?:/i.test(url)) networkCalls.push(url);
    return Promise.reject(new Error(`rede proibida na carta: ${url}`));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function check(png: Buffer) {
  const image = sharp(png);
  const metadata = await image.metadata();
  expect(metadata.format).toBe("png");
  expect(metadata.width).toBe(DEBUT_LETTER_WIDTH);
  expect(metadata.height).toBe(DEBUT_LETTER_HEIGHT);
  const raw = await image.raw().toBuffer({ resolveWithObject: true });
  const pixel = (x: number, y: number) => {
    const offset = (y * raw.info.width + x) * raw.info.channels;
    return [raw.data[offset], raw.data[offset + 1], raw.data[offset + 2]];
  };
  const [r, g] = pixel(80, 200);
  expect(r).toBeGreaterThan(235);
  expect(g).toBeGreaterThan(235);
  // A faixa noir ocupa o pé inteiro (se a carta empurrasse, ela sairia do papel)…
  for (const x of [120, DEBUT_LETTER_WIDTH - 120]) {
    const [nr, ng, nb] = pixel(x, DEBUT_LETTER_HEIGHT - 50);
    expect(nr + ng + nb).toBeLessThan(60);
  }
  // …e o filete dourado de baixo continua dentro do papel.
  let goldBottom = false;
  for (let y = DEBUT_LETTER_HEIGHT - 42; y < DEBUT_LETTER_HEIGHT - 28; y += 1) {
    const [gr, gg, gb] = pixel(DEBUT_LETTER_WIDTH / 2, y);
    if (gr > 180 && gg > 150 && gb < 140) goldBottom = true;
  }
  expect(goldBottom).toBe(true);
  const [nr, ng, nb] = pixel(120, DEBUT_LETTER_HEIGHT - 60);
  expect(nr + ng + nb).toBeLessThan(60);
  expect(networkCalls).toEqual([]);
}

const base: DebutLetterData = {
  recipientName: "Ana",
  text: "Bem-vinda à maison.\nEsta é a sua primeira peça com a gente — escolhida com o cuidado de quem conhece Belém.",
  signature: "Marina, curadora da TRIVÉ",
  editionName: "Edição Círio",
};

describe("renderDebutLetterPng", () => {
  it("carta curta", async () => {
    await check(await renderDebutLetterPng(base, await loadReceiptAssets()));
  });

  it("carta no teto: 12 linhas e ~900 caracteres que o orçamento aceita cabem, com assinatura e faixa no lugar", async () => {
    const text = normalizeDebutLetter(
      Array.from({ length: 12 }, (_, i) => `Linha ${i + 1} da carta, com um pouco mais de texto para pesar a página inteira.`).join("\n"),
    )!;
    expect(text.split("\n")).toHaveLength(DEBUT_LETTER_MAX_LINES);
    expect(text.length).toBeLessThanOrEqual(DEBUT_LETTER_MAX);
    expect(debutLetterProblem(text)).toBeNull();
    await check(await renderDebutLetterPng({ ...base, text, editionName: null }, await loadReceiptAssets()));
    // Poucos parágrafos, mas compridos: as quebras que a largura impõe também cabem.
    const denso = normalizeDebutLetter(Array.from({ length: 4 }, () => "Que bom ter você por aqui, escolhendo uma peça pensada para o calor de Belém e para o seu jeito. ".repeat(2).trim()).join("\n\n"))!;
    expect(denso.length).toBeLessThanOrEqual(DEBUT_LETTER_MAX);
    expect(debutLetterLayout(denso).fits).toBe(true);
    await check(await renderDebutLetterPng({ ...base, text: denso, signature: "MARINA DA SILVA, CURADORA DA MAISON" }, await loadReceiptAssets()));
  });

  it("texto antigo que não cabe nem no menor corpo: a carta corta embaixo, a assinatura e a faixa ficam", async () => {
    const enorme = Array.from({ length: 12 }, () => "PALAVRA COMPRIDA ".repeat(4).trim()).join("\n");
    expect(debutLetterLayout(enorme).fits).toBe(false);
    await check(await renderDebutLetterPng({ ...base, text: enorme }, await loadReceiptAssets()));
  });

  it("emoji no nome ou na assinatura não derruba nem busca fonte", async () => {
    await check(
      await renderDebutLetterPng({ ...base, recipientName: "Ana 🤎", signature: "Marina ✨" }, await loadReceiptAssets()),
    );
  });
});
