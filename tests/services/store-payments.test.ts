import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { FakePaymentGateway } from "@/adapters/mercadopago/fake";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { transitionOrder } from "@/services/orders";
import { createStoreOrder } from "@/services/store-orders";
import {
  ensurePaymentPreference,
  ensurePaymentPreferenceByToken,
  isMpEnabled,
  ServiceError,
  type CreateCheckoutPreferenceInput,
  type StorePaymentGateway,
} from "@/services/store-payments";
import { createTestDb, createTestVariant, type TestDb } from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;
// PGlite (testes) e postgres-js (produção) divergem apenas no tipo de
// retorno de execute(); a API drizzle usada pelos serviços é idêntica.
let sdb: DbOrTx;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await close();
});

const VALID_CPF = "529.982.247-25";

/** Gateway de gravação: guarda o input recebido para asserções de contrato. */
class RecordingGateway implements StorePaymentGateway {
  lastInput: CreateCheckoutPreferenceInput | null = null;
  calls = 0;

  async createCheckoutPreference(input: CreateCheckoutPreferenceInput) {
    this.calls += 1;
    this.lastInput = input;
    return {
      preferenceId: `rec-pref-${this.calls}`,
      initPointUrl: `https://rec.mercadopago.local/checkout/rec-pref-${this.calls}`,
    };
  }
}

async function activatePrice(variantId: string, priceCents: number) {
  await db.insert(schema.priceVersions).values({
    productVariantId: variantId,
    versionNumber: 1,
    status: "active",
    priceCents,
    origin: "initial",
    breakdown: {},
    costSnapshotCents: 1000,
    computedMarginRate: "0.3000",
    activatedAt: new Date(),
  });
}

/** Pedido pending_payment da LOJA, criado pelo fluxo real de checkout. */
async function createPendingStoreOrder(
  opts: { shippingCents?: number; email?: string } = {},
) {
  const shippingCents = opts.shippingCents ?? 1990;
  const { variantId } = await createTestVariant(db, {
    sku: "CANECA-AZUL",
    costCents: 1200,
    onHand: 10,
    name: "Caneca Azul",
  });
  await activatePrice(variantId, 4990);
  const [rate] = await db
    .insert(schema.shippingRates)
    .values({ name: "PAC", priceCents: shippingCents })
    .returning({ id: schema.shippingRates.id });

  return createStoreOrder(sdb, {
    customer: {
      fullName: "Maria da Silva",
      document: VALID_CPF,
      phone: "(11) 99999-8888",
      ...(opts.email !== undefined ? { email: opts.email } : {}),
      marketingOptIn: false,
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
    shippingRateId: rate.id,
    expectedShippingCents: shippingCents,
  });
}

async function getOrderRow(orderId: string) {
  const [row] = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.id, orderId));
  return row;
}

describe("ensurePaymentPreference", () => {
  it("cria a preference no fake, salva mpPreferenceId e retorna o init_point", async () => {
    const order = await createPendingStoreOrder({ email: "maria@example.com" });
    const gateway = new FakePaymentGateway();

    const result = await ensurePaymentPreference(sdb, gateway, {
      orderId: order.orderId,
    });

    expect(result.preferenceId).toBeTruthy();
    expect(result.initPointUrl).toMatch(/^https?:\/\//);

    const row = await getOrderRow(order.orderId);
    expect(row.mpPreferenceId).toBe(result.preferenceId);

    // Audit da mutação (ator sistema).
    const audits = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "order.mp_preference_created"));
    expect(audits).toHaveLength(1);
    expect(audits[0].entityId).toBe(order.orderId);
  });

  it("recria a preference a cada chamada (init_point não é recuperável) e guarda a mais recente", async () => {
    const order = await createPendingStoreOrder();
    const gateway = new FakePaymentGateway();

    const first = await ensurePaymentPreference(sdb, gateway, {
      orderId: order.orderId,
    });
    const second = await ensurePaymentPreference(sdb, gateway, {
      orderId: order.orderId,
    });

    expect(second.preferenceId).not.toBe(first.preferenceId);
    expect(second.initPointUrl).toBeTruthy();
    const row = await getOrderRow(order.orderId);
    expect(row.mpPreferenceId).toBe(second.preferenceId);
  });

  it("monta itens dos snapshots + frete como item e envia o contrato completo ao gateway", async () => {
    // Sem NEXT_PUBLIC_SITE_URL → fallback documentado do site em produção.
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    const order = await createPendingStoreOrder({
      shippingCents: 1990,
      email: "maria@example.com",
    });
    const gateway = new RecordingGateway();

    await ensurePaymentPreference(sdb, gateway, { orderId: order.orderId });

    const input = gateway.lastInput;
    expect(input).not.toBeNull();
    if (!input) return;
    expect(input.orderId).toBe(order.orderId);
    expect(input.orderNumber).toBe(order.orderNumber);
    // Idempotência do pagamento: external_reference é SEMPRE o orderId.
    expect(input.externalReference).toBe(order.orderId);
    expect(input.payerEmail).toBe("maria@example.com");
    expect(input.backUrl).toBe(
      `https://trive-lime.vercel.app/pedido/${order.publicToken}`,
    );
    expect(input.notificationUrl).toBe(
      "https://trive-lime.vercel.app/api/webhooks/mercadopago",
    );
    expect(input.items).toEqual([
      { title: "Caneca Azul", quantity: 2, unitPriceCents: 4990 },
      { title: "Frete", quantity: 1, unitPriceCents: 1990 },
    ]);
    // Total dos itens = total do pedido (itens + frete).
    const sum = input.items.reduce(
      (total, item) => total + item.quantity * item.unitPriceCents,
      0,
    );
    expect(sum).toBe(order.totalCents);
  });

  it("não inclui item de frete quando o frete é grátis", async () => {
    const order = await createPendingStoreOrder({ shippingCents: 0 });
    const gateway = new RecordingGateway();

    await ensurePaymentPreference(sdb, gateway, { orderId: order.orderId });

    expect(
      gateway.lastInput?.items.some((item) => item.title === "Frete"),
    ).toBe(false);
  });

  it("pedido já pago → erro claro, sem chamar o gateway", async () => {
    const order = await createPendingStoreOrder();
    await transitionOrder(sdb, {
      orderId: order.orderId,
      to: "paid",
      userId: null,
    });
    const gateway = new RecordingGateway();

    await expect(
      ensurePaymentPreference(sdb, gateway, { orderId: order.orderId }),
    ).rejects.toMatchObject({
      code: "ORDER_NOT_PAYABLE",
      message: expect.stringContaining("já está pago"),
    });
    expect(gateway.calls).toBe(0);
  });

  it("pedido de canal manual (venda pelo WhatsApp) TAMBÉM paga online", async () => {
    // A venda assistida pelo WhatsApp usa o mesmo link público de pagamento:
    // canal deixou de ser restrição (apenas o status pending_payment importa).
    const { orderId } = await createPendingStoreOrder();
    await db
      .update(schema.orders)
      .set({ channel: "manual" })
      .where(eq(schema.orders.id, orderId));

    const gateway = new RecordingGateway();
    const result = await ensurePaymentPreference(sdb, gateway, { orderId });
    expect(result.preferenceId).toBeTruthy();
    expect(gateway.calls).toBe(1);
  });

  it("pedido inexistente → ORDER_NOT_FOUND", async () => {
    await expect(
      ensurePaymentPreference(sdb, new RecordingGateway(), {
        orderId: "00000000-0000-4000-8000-00000000dead",
      }),
    ).rejects.toBeInstanceOf(ServiceError);
  });
});

describe("ensurePaymentPreferenceByToken", () => {
  it("resolve o publicToken internamente e cria a preference", async () => {
    const order = await createPendingStoreOrder();
    const gateway = new RecordingGateway();

    const result = await ensurePaymentPreferenceByToken(sdb, gateway, {
      publicToken: order.publicToken,
    });

    expect(result.preferenceId).toBe("rec-pref-1");
    expect(gateway.lastInput?.orderId).toBe(order.orderId);
  });

  it("token desconhecido ou inválido → ORDER_NOT_FOUND", async () => {
    const gateway = new RecordingGateway();
    await expect(
      ensurePaymentPreferenceByToken(sdb, gateway, {
        publicToken: "00000000-0000-4000-8000-00000000beef",
      }),
    ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
    await expect(
      ensurePaymentPreferenceByToken(sdb, gateway, {
        publicToken: "nao-e-uuid",
      }),
    ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
    expect(gateway.calls).toBe(0);
  });
});

describe("isMpEnabled", () => {
  async function setMpEnabled(value: boolean) {
    await db.insert(schema.settings).values({ key: "mp_enabled", value });
  }

  it("false quando a setting não existe ou está desligada", async () => {
    expect(await isMpEnabled(sdb)).toBe(false);
    await setMpEnabled(false);
    expect(await isMpEnabled(sdb)).toBe(false);
  });

  it("true com setting ligada em ADAPTER_MODE fake, mesmo SEM credenciais", async () => {
    await setMpEnabled(true);
    vi.stubEnv("ADAPTER_MODE", "fake");
    vi.stubEnv("MP_ACCESS_TOKEN", "");
    expect(await isMpEnabled(sdb)).toBe(true);
  });

  it("em modo real, exige MP_ACCESS_TOKEN presente", async () => {
    await setMpEnabled(true);
    vi.stubEnv("ADAPTER_MODE", "real");
    vi.stubEnv("MP_ACCESS_TOKEN", "");
    expect(await isMpEnabled(sdb)).toBe(false);

    vi.stubEnv("MP_ACCESS_TOKEN", "APP_USR-teste");
    expect(await isMpEnabled(sdb)).toBe(true);
  });

  it("setting desligada vence mesmo com credenciais presentes", async () => {
    await setMpEnabled(false);
    vi.stubEnv("ADAPTER_MODE", "real");
    vi.stubEnv("MP_ACCESS_TOKEN", "APP_USR-teste");
    expect(await isMpEnabled(sdb)).toBe(false);
  });
});
