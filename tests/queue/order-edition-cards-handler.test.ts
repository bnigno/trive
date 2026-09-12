// O handler de order.edition_cards com as dependências injetadas: desenha
// cartões (e a carta, na estreia) e carimba o pedido; pedido sumido ou sem
// peças conclui sem lançar; falha do desenho propaga para a política.
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeFileStorage } from "@/adapters/storage/fake";
import type { DebutLetterData, EditionCardData } from "@/core/edition/types";
import { getRetryPolicy } from "@/core/queue/retry-policy";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { runOrderEditionCards } from "@/queue/handlers/order-edition-cards";
import { createStoreOrder } from "@/services/store-orders";
import { createTestDb, createTestVariant, type TestDb } from "../helpers/db";

vi.mock("@/inngest/client", () => ({ inngest: { send: async () => ({ ids: [] }) } }));

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;
let storage: FakeFileStorage;
const png = () => sharp({ create: { width: 108, height: 144, channels: 3, background: "#fdfbf6" } }).png().toBuffer();
const render = {
  card: vi.fn(async (_data: EditionCardData) => png()),
  letter: vi.fn(async (_data: DebutLetterData) => png()),
};

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  storage = new FakeFileStorage();
  render.card.mockClear();
  render.letter.mockClear();
  vi.stubEnv("ADAPTER_MODE", "fake");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://trivemaison.com.br");
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
});

async function paidOrder() {
  const { productId, variantId } = await createTestVariant(db, { sku: "HND-DUNAS", costCents: 9000, onHand: 3, name: "Longo Dunas" });
  await db.update(schema.products).set({ slug: "longo-dunas" }).where(eq(schema.products.id, productId));
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
  const [rate] = await db.insert(schema.shippingRates).values({ name: "PAC", priceCents: 1990 }).returning({ id: schema.shippingRates.id });
  const created = await createStoreOrder(sdb, {
    customer: { fullName: "Juliana Ramos", document: "529.982.247-25", phone: "(11) 99999-8888", marketingOptIn: true },
    address: { postalCode: "01310-100", street: "Avenida Paulista", number: "1000", district: "Bela Vista", city: "São Paulo", state: "SP" },
    items: [{ variantId, quantity: 1, expectedUnitPriceCents: 28900 }],
    shippingRateId: rate.id,
    expectedShippingCents: 1990,
  });
  await db.update(schema.orders).set({ status: "paid", paidAt: new Date() }).where(eq(schema.orders.id, created.orderId));
  return created.orderId;
}

const event = (orderId: string) => ({ id: "11111111-1111-4111-8111-111111111111", eventType: "order.edition_cards", payload: { orderId } });

describe("runOrderEditionCards", () => {
  it("desenha os cartões e a carta da estreia e carimba o pedido", async () => {
    const orderId = await paidOrder();
    await db.insert(schema.settings).values({ key: "debut_letter_text", value: "Bem-vinda." });
    const result = await runOrderEditionCards({ db: sdb, storage, render }, event(orderId));
    expect(result).toEqual({ skipped: null, cards: 1, letter: true });
    expect(storage.list()).toHaveLength(2);
    const [row] = await db.select({ at: schema.orders.editionCardsAt }).from(schema.orders).where(eq(schema.orders.id, orderId));
    expect(row.at).toBeInstanceOf(Date);
  });

  it("pedido sumido conclui como skip, sem lançar; falha do desenho propaga", async () => {
    expect(await runOrderEditionCards({ db: sdb, storage, render }, event("00000000-0000-4000-8000-0000000000aa"))).toEqual({
      skipped: "pedido_nao_encontrado",
    });
    const orderId = await paidOrder();
    render.card.mockRejectedValueOnce(new Error("Satori caiu"));
    // O serviço traduz a falha do desenho em ServiceError("cartao_falhou"): ainda assim propaga (retry), não é skip.
    await expect(runOrderEditionCards({ db: sdb, storage, render }, event(orderId))).rejects.toMatchObject({ code: "cartao_falhou" });
    expect(storage.list()).toHaveLength(0);
    // Política curta: tenta mais uma vez e para (a dona refaz na tela).
    expect(getRetryPolicy("order.edition_cards").maxAttempts).toBe(2);
  });
});
