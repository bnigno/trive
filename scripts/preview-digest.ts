// Prévia do "Bom dia da maison" em PNG, para conferir o desenho antes de
// ligar. Com banco: números reais do dia pedido (DATABASE_URL). Com --fake:
// dados de exemplo, sem banco.
// Uso: npx tsx --env-file=.env.local scripts/preview-digest.ts [YYYY-MM-DD] [--fake] [saida.png]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { openingFor } from "@/core/digest/openings";
import type { DailyDigestData } from "@/core/digest/types";
import { loadReceiptAssets } from "@/receipts/assets";
import { renderDailyDigestPng } from "@/receipts/render-digest";
import { spDayLabel, weekdayIndexSP } from "@/lib/sp-day";

function fakeData(date: string, empty: boolean): DailyDigestData {
  const weekdayIndex = weekdayIndexSP(date);
  return {
    dayKey: date,
    dayLabel: spDayLabel(date),
    weekdayIndex,
    opening: openingFor(weekdayIndex, !empty),
    sales: empty
      ? { paidOrders: 0, revenueCents: 0, averageTicketCents: 0, newOrders: 1 }
      : { paidOrders: 4, revenueCents: 124700, averageTicketCents: 31175, newOrders: 6 },
    waiting: { pendingPayment: 2, toPack: 1, toShip: 3, conversationsAwaitingOwner: 1, mustShipToday: 1 },
    bot: empty
      ? { conversations: 0, turns: 0, handoffs: 0, orders: 0, ordersCents: 0, costUsdCents: 0, studioImages: 0, studioUsdCents: 0 }
      : { conversations: 6, turns: 19, handoffs: 1, orders: 2, ordersCents: 57800, costUsdCents: 42, studioImages: 9, studioUsdCents: 99 },
    lowStock: empty
      ? []
      : [
          { name: "Vestido Dunas Preto M", sku: "DUNAS-PRET-M", available: 0 },
          { name: "Blusa Linho Areia G", sku: "LINHO-AREI-G", available: 1 },
          { name: "Saia Midi Verde Militar P", sku: "SAIA-VERD-P", available: 2 },
        ],
    bestSeller: empty ? null : { name: "Vestido Dunas", quantity: 5, revenueCents: 144500 },
    editions: empty ? [] : [{ name: "Edição Círio", isCurrent: false, daysUntil: 28, products: 12, missingPhoto: 2 }],
    storeName: "TRIVÉ",
    generatedAt: new Date(),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const fake = args.includes("--fake");
  const empty = args.includes("--vazio");
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const date = positional.find((arg) => /^\d{4}-\d{2}-\d{2}$/.test(arg)) ?? "2026-09-09";
  const out =
    positional.find((arg) => arg.endsWith(".png")) ?? `.preview/digest-${date}${empty ? "-vazio" : ""}.png`;

  let data: DailyDigestData;
  if (fake) {
    data = fakeData(date, empty);
  } else {
    const { getDb } = await import("@/db/client");
    const { buildDailyDigestData } = await import("@/services/daily-digest");
    data = await buildDailyDigestData(getDb(), { date });
  }

  const png = await renderDailyDigestPng(data, await loadReceiptAssets());
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, png);
  console.log(`prévia gravada em ${out}`);
  console.log(JSON.stringify({ ...data, generatedAt: data.generatedAt.toISOString() }, null, 2));
  process.exit(0);
}

main().catch((error) => {
  console.error("Prévia falhou:", error);
  process.exit(1);
});
