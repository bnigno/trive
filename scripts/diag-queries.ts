// Diagnóstico: cronometra cada consulta usada pelas páginas do admin.
// Uso: npx tsx --env-file=<env> scripts/diag-queries.ts
import { getDb } from "@/db/client";
import { getFeeRules, getDefaultPolicy, getSettingsMap } from "@/services/settings";
import { listShippingRates } from "@/services/shipping";
import { listProducts } from "@/services/catalog";
import { getStockOverview } from "@/services/stock";
import { monthOverview } from "@/services/financial";
import { listPendingApprovals } from "@/services/pricing";
import { listOrders } from "@/services/orders";

const db = getDb();

async function timeIt(label: string, fn: () => Promise<unknown>) {
  const t0 = performance.now();
  try {
    await Promise.race([
      fn(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("TIMEOUT 15s")), 15_000)),
    ]);
    console.log(`${label}: ${Math.round(performance.now() - t0)}ms`);
  } catch (e) {
    console.log(`${label}: FALHOU após ${Math.round(performance.now() - t0)}ms — ${(e as Error).message.slice(0, 120)}`);
  }
}

async function main() {
  await timeIt("select 1 (aquecimento)", () => db.execute("select 1"));
  await timeIt("getSettingsMap", () => getSettingsMap(db, ["store_name", "store_cnpj"]));
  await timeIt("getFeeRules", () => getFeeRules(db));
  await timeIt("getDefaultPolicy", () => getDefaultPolicy(db));
  await timeIt("listShippingRates", () => listShippingRates(db));
  await timeIt("listProducts", () => listProducts(db, {}));
  await timeIt("getStockOverview", () => getStockOverview(db));
  await timeIt("monthOverview", () => monthOverview(db, { year: 2026, month: 8 }));
  await timeIt("listPendingApprovals", () => listPendingApprovals(db));
  await timeIt("listOrders", () => listOrders(db, {}));
  process.exit(0);
}

void main();
