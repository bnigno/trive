// Desenho real do bilhete: PNG 1080×720, sem rede, com mensagem curta, com os
// 280 caracteres em 6 linhas e sem mensagem.
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { normalizeGiftText } from "@/core/gifts/text";
import type { GiftNoteData } from "@/core/gifts/types";
import { loadReceiptAssets } from "@/receipts/assets";
import { GIFT_NOTE_HEIGHT, GIFT_NOTE_WIDTH, renderGiftNotePng } from "@/receipts/render-gift-note";

const originalFetch = globalThis.fetch;
const networkCalls: string[] = [];

beforeEach(() => {
  networkCalls.length = 0;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (/^https?:/i.test(url)) networkCalls.push(url);
    return Promise.reject(new Error(`rede proibida no bilhete: ${url}`));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function check(png: Buffer) {
  const image = sharp(png);
  const metadata = await image.metadata();
  expect(metadata.format).toBe("png");
  expect(metadata.width).toBe(GIFT_NOTE_WIDTH);
  expect(metadata.height).toBe(GIFT_NOTE_HEIGHT);
  const raw = await image.raw().toBuffer({ resolveWithObject: true });
  const pixel = (x: number, y: number) => {
    const offset = (y * raw.info.width + x) * raw.info.channels;
    return [raw.data[offset], raw.data[offset + 1], raw.data[offset + 2]];
  };
  // Papel marfim no meio; faixa noir embaixo.
  const [r, g] = pixel(80, 200);
  expect(r).toBeGreaterThan(235);
  expect(g).toBeGreaterThan(235);
  const [nr, ng, nb] = pixel(120, GIFT_NOTE_HEIGHT - 60);
  expect(nr + ng + nb).toBeLessThan(60);
  expect(networkCalls).toEqual([]);
}

const base: GiftNoteData = {
  recipientName: "Ana Clara",
  message: "Para iluminar o seu setembro.",
  signature: "Com carinho, Marina",
  storeName: "TRIVÉ",
};

describe("renderGiftNotePng", () => {
  it("mensagem curta", async () => {
    await check(await renderGiftNotePng(base, await loadReceiptAssets()));
  });

  it("280 caracteres em 6 linhas cabem; emoji no nome não derruba", async () => {
    const message = normalizeGiftText(
      "Mãe, cada vez que eu penso em elegância, penso em você.\nQue este vestido te acompanhe nos dias bonitos que ainda vêm.\nObrigada por tudo o que você me ensinou sem dizer uma palavra.\nFeliz aniversário!\nCom todo o meu amor,\nhoje e sempre e sempre e sempre e sempre e sempre e sempre.",
    );
    expect(message.length).toBeLessThanOrEqual(280);
    expect(message.split("\n")).toHaveLength(6);
    await check(
      await renderGiftNotePng({ ...base, recipientName: "Mãe 🤎", message }, await loadReceiptAssets()),
    );
  });

  it("sem mensagem mostra a frase da maison", async () => {
    await check(await renderGiftNotePng({ ...base, message: null }, await loadReceiptAssets()));
  });
});
