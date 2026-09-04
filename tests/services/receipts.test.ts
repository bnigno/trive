// Comprovante de pagamento: pré-checagens antes de renderizar, path
// determinístico, idempotência e a promessa de nenhum dado pessoal.
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeFileStorage } from "@/adapters/storage/fake";
import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import {
  buildReceiptData,
  publishOrderReceipt,
  receiptDedupeKey,
  receiptStoragePath,
  sendReceiptWa,
  type ReceiptRenderer,
} from "@/services/receipts";
import { createStoreOrder, type CreateStoreOrderInput } from "@/services/store-orders";
import { createTestDb, createTestVariant, type TestDb } from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;
let sdb: DbOrTx;
let storage: FakeFileStorage;
let provider: FakeMessagingProvider;
let renders = 0;

const VALID_CPF = "529.982.247-25";

const render: ReceiptRenderer = async () => {
  renders += 1;
  return sharp({
    create: { width: 1080, height: 1350, channels: 3, background: "#faf7f0" },
  })
    .png()
    .toBuffer();
};

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  storage = new FakeFileStorage();
  provider = new FakeMessagingProvider();
  renders = 0;
});

afterEach(async () => {
  await close();
});

async function enableWa(): Promise<void> {
  await db.insert(schema.settings).values({ key: "wa_enabled", value: true });
}

async function seedTemplate(isActive = true): Promise<void> {
  await db.insert(schema.waTemplates).values({
    key: "payment_receipt",
    label: "Comprovante",
    bodyTemplate:
      "{{nome}}, este é o comprovante do pagamento do pedido #{{pedido}}. Acompanhe: {{link}}",
    variables: ["nome", "pedido", "link"],
    isActive,
  });
}

async function createPaidOrder(over: { marketingOptIn?: boolean } = {}) {
  const { variantId } = await createTestVariant(db, {
    sku: "VE-38",
    costCents: 9000,
    onHand: 5,
    name: "Vestido Ébano 🤍",
  });
  await db.insert(schema.priceVersions).values({
    productVariantId: variantId,
    versionNumber: 1,
    status: "active",
    priceCents: 28900,
    origin: "initial",
    breakdown: {},
    costSnapshotCents: 9000,
    computedMarginRate: "0.3000",
    activatedAt: new Date(),
  });
  const [rate] = await db
    .insert(schema.shippingRates)
    .values({ name: "PAC", priceCents: 1990 })
    .returning({ id: schema.shippingRates.id });
  const input: CreateStoreOrderInput = {
    customer: {
      fullName: "Maria da Silva",
      document: VALID_CPF,
      phone: "(11) 99999-8888",
      email: "maria@example.com",
      marketingOptIn: over.marketingOptIn ?? true,
    },
    address: {
      postalCode: "01310-100",
      street: "Avenida Paulista",
      number: "1000",
      district: "Bela Vista",
      city: "São Paulo",
      state: "SP",
    },
    items: [{ variantId, quantity: 2, expectedUnitPriceCents: 28900 }],
    shippingRateId: rate.id,
    expectedShippingCents: 1990,
  };
  const order = await createStoreOrder(sdb, input);
  await db
    .update(schema.orders)
    .set({ status: "paid", paidAt: new Date("2026-09-04T14:30:00-03:00"), paymentMethod: "pix_manual" })
    .where(eq(schema.orders.id, order.orderId));
  return order.orderId;
}

describe("buildReceiptData", () => {
  it("monta os dados sem nenhum campo pessoal e com os nomes limpos", async () => {
    const orderId = await createPaidOrder();
    await db.insert(schema.settings).values([
      { key: "store_name", value: "TRIVÉ" },
      { key: "store_cnpj", value: "12.345.678/0001-90" },
    ]);

    const data = await buildReceiptData(sdb, orderId);
    expect(Object.keys(data).sort()).toEqual(
      [
        "discountCents",
        "items",
        "orderNumber",
        "paidAt",
        "paymentLabel",
        "shippingCents",
        "storeCnpj",
        "storeName",
        "subtotalCents",
        "totalCents",
      ].sort(),
    );
    expect(JSON.stringify(data)).not.toMatch(/Maria|529\.982|99999|Paulista|maria@/);
    expect(data.items).toEqual([
      { name: "Vestido Ébano", sku: "VE-38", quantity: 2, unitPriceCents: 28900, totalCents: 57800 },
    ]);
    expect(data).toMatchObject({
      paymentLabel: "Pix manual",
      subtotalCents: 57800,
      shippingCents: 1990,
      totalCents: 59790,
      storeName: "TRIVÉ",
      storeCnpj: "12.345.678/0001-90",
    });
  });

  it("recusa pedido sem pagamento confirmado", async () => {
    const orderId = await createPaidOrder();
    await db.update(schema.orders).set({ paidAt: null }).where(eq(schema.orders.id, orderId));
    await expect(buildReceiptData(sdb, orderId)).rejects.toMatchObject({ code: "nao_pago" });
  });
});

describe("publishOrderReceipt", () => {
  it("sobe o JPEG no path determinístico e grava orders.receipt_path", async () => {
    const orderId = await createPaidOrder();
    const result = await publishOrderReceipt(sdb, storage, render, { orderId });

    expect(result.path).toBe(receiptStoragePath(orderId));
    expect(result.url).toMatch(/^memory:\/\/receipts\/.*\/comprovante\.jpg\?v=\d+$/);
    const stored = storage.get(result.path);
    expect(stored?.contentType).toBe("image/jpeg");
    expect((await sharp(Buffer.from(stored!.data)).metadata()).format).toBe("jpeg");

    const [row] = await db
      .select({ receiptPath: schema.orders.receiptPath })
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId));
    expect(row.receiptPath).toBe(result.path);
  });
});

describe("sendReceiptWa", () => {
  it("envia uma vez e a segunda execução não renderiza, não sobe nem envia de novo", async () => {
    await enableWa();
    await seedTemplate();
    const orderId = await createPaidOrder();

    const first = await sendReceiptWa(sdb, provider, storage, render, { orderId });
    expect(first).toMatchObject({ sent: true });
    expect(renders).toBe(1);
    expect(storage.list()).toEqual([receiptStoragePath(orderId)]);
    expect(provider.sentImages).toHaveLength(1);
    expect(provider.sentImages[0].imageUrl).toContain("?v=");
    expect(provider.sentImages[0].caption).toMatch(/Maria, este é o comprovante do pagamento do pedido #\d+/);

    const messages = await db.select().from(schema.waMessages);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      kind: "image",
      dedupeKey: receiptDedupeKey(orderId),
      orderId,
    });
    expect(messages[0].mediaUrl).toContain("?v=");

    const second = await sendReceiptWa(sdb, provider, storage, render, { orderId });
    expect(second).toEqual({ skipped: "ja_enviado" });
    expect(renders).toBe(1);
    expect(provider.sentImages).toHaveLength(1);
    expect(await db.select().from(schema.waMessages)).toHaveLength(1);
  });

  it("pula sem renderizar nem subir nada: WhatsApp desligado, sem opt-in, sem template", async () => {
    const orderId = await createPaidOrder({ marketingOptIn: false });

    expect(await sendReceiptWa(sdb, provider, storage, render, { orderId })).toEqual({
      skipped: "desabilitado",
    });

    await enableWa();
    expect(await sendReceiptWa(sdb, provider, storage, render, { orderId })).toEqual({
      skipped: "sem_opt_in",
    });

    await db
      .update(schema.customers)
      .set({ marketingOptIn: true });
    expect(await sendReceiptWa(sdb, provider, storage, render, { orderId })).toEqual({
      skipped: "sem_template",
    });

    expect(renders).toBe(0);
    expect(storage.list()).toEqual([]);
    expect(provider.sentImages).toHaveLength(0);
  });
});
