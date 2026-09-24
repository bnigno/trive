// O aviso "saiu" do motoboy pela fila: a primeira saída usa a chave de
// sempre (um "saiu" por pedido, por qualquer caminho); a segunda saída de
// quem voltou sem entregar (`againAt`) tem chave própria — antes, o dedupe
// engolia o aviso e a cliente não sabia que a peça saiu de novo.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/db/schema";
import { initialWaTemplates } from "@/db/seed-data";
import type { DbOrTx } from "@/queue/enqueue";
import { createStoreOrder } from "@/services/store-orders";
import { createTestDb, createTestVariant, type TestDb } from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;
vi.mock("@/inngest/client", () => ({ inngest: { send: async () => ({ ids: [] }) } }));
vi.mock("@/db/client", () => ({ getDb: () => db }));
const { outboxHandlers } = await import("@/queue/handlers");

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  vi.stubEnv("ADAPTER_MODE", "fake");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://trivemaison.com.br");
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
});

async function motoboyCashOrder() {
  const sdb = db as unknown as DbOrTx;
  const { variantId } = await createTestVariant(db, { sku: "SAIU-DUNAS", costCents: 1200, onHand: 5, name: "Longo Dunas" });
  await db.insert(schema.priceVersions).values({
    productVariantId: variantId,
    versionNumber: 1,
    status: "active",
    priceCents: 15900,
    origin: "initial",
    breakdown: {},
    costSnapshotCents: 1000,
    computedMarginRate: "0.3000",
    activatedAt: new Date(),
  });
  const window = { start: "16:00", end: "19:00", cutoff: "13:00" };
  const [rate] = await db
    .insert(schema.shippingRates)
    .values({ name: "Motoboy Belém", priceCents: 1500, kind: "motoboy", cepStart: "66000000", cepEnd: "66999999", deliveryWindows: [window], deliveryDaysMin: 0, deliveryDaysMax: 0 })
    .returning({ id: schema.shippingRates.id });
  const created = await createStoreOrder(
    sdb,
    {
      customer: { fullName: "Ana Souza", document: "529.982.247-25", phone: "(91) 98888-1234", email: "ana@example.com", marketingOptIn: true },
      address: { postalCode: "66050-000", street: "Av. Nazaré", number: "100", complement: "", district: "Nazaré", city: "Belém", state: "PA" },
      items: [{ variantId, quantity: 1, expectedUnitPriceCents: 15900 }],
      shippingRateId: rate.id,
      expectedShippingCents: 1500,
      deliveryWindow: { dayKey: "2026-09-18", ...window },
      paymentMethod: "cash",
    },
    { now: new Date("2026-09-18T13:30:00Z") },
  );
  await db.insert(schema.settings).values({ key: "wa_enabled", value: true });
  const template = initialWaTemplates.find((row) => row.key === "order_out_for_delivery")!;
  await db.insert(schema.waTemplates).values({ key: template.key, label: template.label, bodyTemplate: template.bodyTemplate, variables: template.variables });
  return created;
}

async function sentKeys(orderId: string): Promise<(string | null)[]> {
  const rows = await db
    .select({ dedupeKey: schema.waMessages.dedupeKey, templateKey: schema.waMessages.templateKey })
    .from(schema.waMessages)
    .where(eq(schema.waMessages.orderId, orderId));
  return rows.filter((row) => row.templateKey === "order_out_for_delivery").map((row) => row.dedupeKey);
}

describe("order.out_for_delivery", () => {
  it("primeira saída: a chave de sempre; segunda saída de quem voltou: chave com a hora — e cada uma só uma vez", async () => {
    const order = await motoboyCashOrder();
    const handler = outboxHandlers["order.out_for_delivery"];
    const event = (payload: Record<string, unknown>) => ({ id: "e", eventType: "order.out_for_delivery", payload, attempts: 0 }) as unknown as Parameters<typeof handler>[0];

    await handler(event({ orderId: order.orderId, orderNumber: order.orderNumber }));
    await handler(event({ orderId: order.orderId, orderNumber: order.orderNumber }));
    expect(await sentKeys(order.orderId)).toEqual([`wa.order_out_for_delivery:${order.orderId}`]);

    const againAt = "2026-09-20T18:00:00.000Z";
    await handler(event({ orderId: order.orderId, orderNumber: order.orderNumber, againAt }));
    await handler(event({ orderId: order.orderId, orderNumber: order.orderNumber, againAt }));
    expect((await sentKeys(order.orderId)).sort()).toEqual([`wa.order_out_for_delivery:${order.orderId}`, `wa.order_out_for_delivery:${order.orderId}:${againAt}`].sort());
  });
});
