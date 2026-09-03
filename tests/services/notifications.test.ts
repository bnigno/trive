import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { FakeEmailProvider } from "@/adapters/email/fake";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { sendOrderEmail } from "@/services/notifications";
import { createStoreOrder, type CreateStoreOrderInput } from "@/services/store-orders";
import { createTestDb, createTestVariant, type TestDb } from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;
// PGlite (testes) e postgres-js (produção) divergem apenas no tipo de retorno
// de execute(); a API drizzle usada pelos serviços é idêntica.
let sdb: DbOrTx;
let emailProvider: FakeEmailProvider;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  emailProvider = new FakeEmailProvider();
});

afterEach(async () => {
  await close();
});

const VALID_CPF = "529.982.247-25";

/** Vitrine pronta: variante ativa com preço, estoque e uma opção de frete. */
async function setupStore() {
  const { variantId } = await createTestVariant(db, {
    sku: "CANECA-AZUL",
    costCents: 1200,
    onHand: 10,
    name: "Caneca Azul",
  });
  await db.insert(schema.priceVersions).values({
    productVariantId: variantId,
    versionNumber: 1,
    status: "active",
    priceCents: 4990,
    origin: "initial",
    breakdown: {},
    costSnapshotCents: 1200,
    computedMarginRate: "0.3000",
    activatedAt: new Date(),
  });
  const [rate] = await db
    .insert(schema.shippingRates)
    .values({ name: "PAC", priceCents: 1990 })
    .returning({ id: schema.shippingRates.id });
  return { variantId, shippingRateId: rate.id };
}

function baseInput(
  variantId: string,
  shippingRateId: string,
  over: Partial<CreateStoreOrderInput> = {},
): CreateStoreOrderInput {
  return {
    customer: {
      fullName: "Maria da Silva",
      document: VALID_CPF,
      phone: "(11) 99999-8888",
      email: "maria@example.com",
      marketingOptIn: true,
    },
    address: {
      postalCode: "01310-100",
      street: "Avenida Paulista",
      number: "1000",
      district: "Bela Vista",
      city: "São Paulo",
      state: "SP",
    },
    items: [{ variantId, quantity: 2, expectedUnitPriceCents: 4990 }],
    shippingRateId,
    expectedShippingCents: 1990,
    ...over,
  };
}

describe("sendOrderEmail", () => {
  it("kind 'confirmed': envia com nº do pedido no assunto e link público no corpo", async () => {
    const { variantId, shippingRateId } = await setupStore();
    const order = await createStoreOrder(sdb, baseInput(variantId, shippingRateId));

    const result = await sendOrderEmail(sdb, emailProvider, {
      orderId: order.orderId,
      kind: "confirmed",
    });

    expect(result).toEqual({ sent: true });
    expect(emailProvider.sentEmails).toHaveLength(1);
    const email = emailProvider.sentEmails[0];
    expect(email.to).toBe("maria@example.com");
    expect(email.subject).toContain(`#${order.orderNumber}`);
    expect(email.html).toContain(`/pedido/${order.publicToken}`);
    expect(email.text).toContain(`/pedido/${order.publicToken}`);
    expect(email.html).toContain("Caneca Azul");

    // Audit registrado com o kind (base da idempotência).
    const auditRows = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "notification.email"));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].entityId).toBe(order.orderId);
    expect((auditRows[0].after as { kind?: string }).kind).toBe("confirmed");
  });

  it("cliente sem e-mail: retorna skipped 'sem_email' sem lançar erro", async () => {
    const { variantId, shippingRateId } = await setupStore();
    const input = baseInput(variantId, shippingRateId);
    delete input.customer.email;
    const order = await createStoreOrder(sdb, input);

    const result = await sendOrderEmail(sdb, emailProvider, {
      orderId: order.orderId,
      kind: "confirmed",
    });

    expect(result).toEqual({ skipped: "sem_email" });
    expect(emailProvider.sentEmails).toHaveLength(0);
  });

  it("reenvio do mesmo kind: skip idempotente (um único e-mail)", async () => {
    const { variantId, shippingRateId } = await setupStore();
    const order = await createStoreOrder(sdb, baseInput(variantId, shippingRateId));

    const first = await sendOrderEmail(sdb, emailProvider, {
      orderId: order.orderId,
      kind: "confirmed",
    });
    const second = await sendOrderEmail(sdb, emailProvider, {
      orderId: order.orderId,
      kind: "confirmed",
    });

    expect(first).toEqual({ sent: true });
    expect(second).toEqual({ skipped: "ja_enviado" });
    expect(emailProvider.sentEmails).toHaveLength(1);

    // Kind diferente NÃO é bloqueado pela idempotência.
    const paid = await sendOrderEmail(sdb, emailProvider, {
      orderId: order.orderId,
      kind: "paid",
    });
    expect(paid).toEqual({ sent: true });
    expect(emailProvider.sentEmails).toHaveLength(2);
  });

  it("kind 'shipped': inclui o código de rastreio quando presente", async () => {
    const { variantId, shippingRateId } = await setupStore();
    const order = await createStoreOrder(sdb, baseInput(variantId, shippingRateId));
    await db
      .update(schema.orders)
      .set({ shippingTrackingCode: "BR123456789XX" })
      .where(eq(schema.orders.id, order.orderId));

    const result = await sendOrderEmail(sdb, emailProvider, {
      orderId: order.orderId,
      kind: "shipped",
    });

    expect(result).toEqual({ sent: true });
    expect(emailProvider.sentEmails).toHaveLength(1);
    const email = emailProvider.sentEmails[0];
    expect(email.subject).toContain(`#${order.orderNumber}`);
    expect(email.html).toContain("BR123456789XX");
    expect(email.text).toContain("BR123456789XX");
  });

  it("usa o store_name das settings no assunto quando configurado", async () => {
    await db
      .insert(schema.settings)
      .values({ key: "store_name", value: "Ateliê TRIVÉ" });
    const { variantId, shippingRateId } = await setupStore();
    const order = await createStoreOrder(sdb, baseInput(variantId, shippingRateId));

    await sendOrderEmail(sdb, emailProvider, {
      orderId: order.orderId,
      kind: "paid",
    });

    expect(emailProvider.sentEmails[0].subject).toContain("Ateliê TRIVÉ");
  });
});
