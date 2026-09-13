// Desenho real do "Bom dia da maison": PNG 1080×1350 com os assets
// embutidos, sem nenhuma ida à rede, com dia cheio e dia vazio.
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DailyDigestData } from "@/core/digest/types";
import { loadReceiptAssets } from "@/receipts/assets";
import {
  DIGEST_HEIGHT,
  DIGEST_WIDTH,
  renderDailyDigestPng,
} from "@/receipts/render-digest";

const full: DailyDigestData = {
  dayKey: "2026-09-09",
  dayLabel: "quarta-feira, 9 de setembro",
  weekdayIndex: 3,
  opening: "Meio de semana. Ontem rendeu isto.",
  sales: { paidOrders: 4, revenueCents: 124700, averageTicketCents: 31175, newOrders: 6 },
  waiting: { pendingPayment: 2, toPack: 1, toShip: 3, conversationsAwaitingOwner: 1, mustShipToday: 0 },
  bot: { conversations: 6, turns: 19, handoffs: 1, orders: 2, ordersCents: 57800, costUsdCents: 42 },
  lowStock: [
    { name: "Vestido Dunas Preto M com um nome comprido demais para caber na linha", sku: "DUNAS-PRET-M", available: 0 },
    { name: "Blusa Linho Areia G", sku: "LINHO-AREI-G", available: 1 },
  ],
  bestSeller: { name: "Vestido Dunas", quantity: 5, revenueCents: 144500 },
  editions: [{ name: "Edição Círio", isCurrent: false, daysUntil: 28, products: 12, missingPhoto: 2 }],
  storeName: "TRIVÉ",
  generatedAt: new Date("2026-09-10T11:00:00Z"),
};

const empty: DailyDigestData = {
  ...full,
  opening: "Ontem foi dia de descanso. Hoje é dia de vender.",
  sales: { paidOrders: 0, revenueCents: 0, averageTicketCents: 0, newOrders: 0 },
  waiting: { pendingPayment: 0, toPack: 0, toShip: 0, conversationsAwaitingOwner: 0, mustShipToday: 0 },
  bot: { conversations: 0, turns: 0, handoffs: 0, orders: 0, ordersCents: 0, costUsdCents: 0 },
  lowStock: [],
  bestSeller: null,
    editions: [],
};

const originalFetch = globalThis.fetch;
const networkCalls: string[] = [];

beforeEach(() => {
  networkCalls.length = 0;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (/^https?:/i.test(url)) networkCalls.push(url);
    return Promise.reject(new Error(`rede proibida no resumo: ${url}`));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("renderDailyDigestPng", () => {
  it("dia cheio: PNG 1080×1350, faixa noir em cima e marfim embaixo, sem rede", async () => {
    const png = await renderDailyDigestPng(full, await loadReceiptAssets());
    const image = sharp(png);
    const metadata = await image.metadata();
    expect(metadata.format).toBe("png");
    expect(metadata.width).toBe(DIGEST_WIDTH);
    expect(metadata.height).toBe(DIGEST_HEIGHT);

    const raw = await image.raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => {
      const offset = (y * raw.info.width + x) * raw.info.channels;
      return [raw.data[offset], raw.data[offset + 1], raw.data[offset + 2]];
    };
    const [tr, tg, tb] = pixel(20, 20);
    expect(tr + tg + tb).toBeLessThan(60);
    const [br, bg, bb] = pixel(20, DIGEST_HEIGHT - 20);
    expect(br).toBeGreaterThan(230);
    expect(bg).toBeGreaterThan(230);
    expect(bb).toBeGreaterThan(220);
    expect(networkCalls).toEqual([]);
  });

  it("dia vazio também renderiza", async () => {
    const png = await renderDailyDigestPng(empty, await loadReceiptAssets());
    const metadata = await sharp(png).metadata();
    expect(metadata.width).toBe(DIGEST_WIDTH);
    expect(metadata.height).toBe(DIGEST_HEIGHT);
    expect(networkCalls).toEqual([]);
  });
});
