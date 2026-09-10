// "Sua peça foi embalada": foto processada (JPEG ≤ 1200 px, sem EXIF),
// transição paid → preparing pela máquina de estados, um único evento
// order.packed por pedido (refazer não reenvia) e o envio com opt-in.
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeFileStorage } from "@/adapters/storage/fake";
import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import {
  countOrdersAwaitingPacking,
  listOrdersAwaitingPacking,
  packagePhotoStoragePath,
  packedDedupeKey,
  packOrder,
  sendPackedWa,
} from "@/services/packing";
import { createStoreOrder, getPublicOrder, type CreateStoreOrderInput } from "@/services/store-orders";
import { createTestDb, createTestUser, createTestVariant, type TestDb } from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;
let sdb: DbOrTx;
let storage: FakeFileStorage;
let provider: FakeMessagingProvider;
let userId: string;

const VALID_CPF = "529.982.247-25";

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  storage = new FakeFileStorage();
  provider = new FakeMessagingProvider();
  userId = (await createTestUser(db)).id;
});

afterEach(async () => {
  await close();
});

/** Foto "do celular": JPEG 2400×1600 com EXIF (o serviço precisa descartar). */
async function cameraPhoto(): Promise<Uint8Array> {
  return sharp({
    create: { width: 2400, height: 1600, channels: 3, background: "#c0a050" },
  })
    .jpeg({ quality: 90 })
    .withMetadata({ exif: { IFD0: { Copyright: "TRIVE-TESTE", ImageDescription: "rua tal, 100" } } })
    .toBuffer();
}

async function seedTemplate(isActive = true): Promise<void> {
  await db.insert(schema.waTemplates).values({
    key: "order_packed",
    label: "Peça embalada",
    bodyTemplate: "{{nome}}, sua peça foi embalada com carinho. Acompanhe: {{link}}",
    variables: ["nome", "link"],
    isActive,
  });
}

async function createPaidOrder(
  over: { marketingOptIn?: boolean; status?: string } = {},
): Promise<{ orderId: string; publicToken: string }> {
  const { variantId } = await createTestVariant(db, {
    sku: `VE-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    costCents: 9000,
    onHand: 5,
    name: "Vestido Ébano",
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
    .set({ status: over.status ?? "paid", paidAt: new Date("2026-09-10T10:00:00-03:00") })
    .where(eq(schema.orders.id, order.orderId));
  return { orderId: order.orderId, publicToken: order.publicToken };
}

async function packedEvents(orderId: string) {
  return db
    .select()
    .from(schema.outboxEvents)
    .where(eq(schema.outboxEvents.dedupeKey, `order.packed:${orderId}`));
}

describe("packOrder", () => {
  it("pago: processa a foto, vira 'preparing', grava o carimbo e enfileira UM order.packed", async () => {
    const { orderId } = await createPaidOrder();
    const before = Date.now();

    const result = await packOrder(sdb, storage, {
      orderId,
      photo: { data: await cameraPhoto(), contentType: "image/jpeg" },
      userId,
    });

    expect(result).toMatchObject({
      orderId,
      status: "preparing",
      packagePhotoPath: packagePhotoStoragePath(orderId),
      transitioned: true,
      rephoto: false,
    });
    expect(result.packedAt.getTime()).toBeGreaterThanOrEqual(before);

    // Arquivo: JPEG, lado maior ≤ 1200, sem EXIF (endereço na foto não vaza).
    const stored = storage.get(result.packagePhotoPath);
    expect(stored?.contentType).toBe("image/jpeg");
    const meta = await sharp(Buffer.from(stored!.data)).metadata();
    expect(meta.format).toBe("jpeg");
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(1200);
    expect(meta.exif).toBeUndefined();

    const [row] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId));
    expect(row.status).toBe("preparing");
    expect(row.packagePhotoPath).toBe(result.packagePhotoPath);
    expect(row.packedAt).not.toBeNull();

    // Transição passou pela máquina de estados: histórico e evento order.preparing.
    const history = await db
      .select({ to: schema.orderStatusHistory.toStatus })
      .from(schema.orderStatusHistory)
      .where(eq(schema.orderStatusHistory.orderId, orderId));
    expect(history.map((entry) => entry.to)).toContain("preparing");

    expect(await packedEvents(orderId)).toHaveLength(1);
    const [audit] = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "order.packed"));
    expect(audit.after).toMatchObject({ rephoto: false, transitioned: true });

    // A página pública passa a ter os carimbos e a foto.
    const [order] = await db
      .select({ token: schema.orders.publicToken })
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId));
    const pub = await getPublicOrder(sdb, order.token);
    expect(pub?.packagePhotoPath).toBe(result.packagePhotoPath);
    expect(pub?.packedAt).not.toBeNull();
    expect(pub?.preparingAt).not.toBeNull();
    expect(JSON.stringify(pub)).not.toMatch(/Maria|Paulista|99999/);
  });

  it("refazer a foto em 'preparing': troca o arquivo e o carimbo, sem segundo evento", async () => {
    const { orderId } = await createPaidOrder();
    const first = await packOrder(sdb, storage, {
      orderId,
      photo: { data: await cameraPhoto(), contentType: "image/jpeg" },
      userId,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await packOrder(sdb, storage, {
      orderId,
      photo: { data: await cameraPhoto(), contentType: "image/png" },
      userId,
    });

    expect(second.rephoto).toBe(true);
    expect(second.transitioned).toBe(false);
    expect(second.status).toBe("preparing");
    expect(second.packagePhotoPath).toBe(first.packagePhotoPath);
    expect(second.packedAt.getTime()).toBeGreaterThan(first.packedAt.getTime());
    expect(storage.list()).toEqual([first.packagePhotoPath]);
    expect(await packedEvents(orderId)).toHaveLength(1);
  });

  it("recusa pedido fora de pago/separação e foto que não é imagem — sem tocar no storage", async () => {
    const { orderId } = await createPaidOrder({ status: "pending_payment" });
    await expect(
      packOrder(sdb, storage, {
        orderId,
        photo: { data: await cameraPhoto(), contentType: "image/jpeg" },
        userId,
      }),
    ).rejects.toMatchObject({ code: "STATUS_INVALIDO" });

    const paid = await createPaidOrder();
    await expect(
      packOrder(sdb, storage, {
        orderId: paid.orderId,
        photo: { data: new Uint8Array([1, 2, 3]), contentType: "image/jpeg" },
        userId,
      }),
    ).rejects.toMatchObject({ code: "imagem_invalida" });
    await expect(
      packOrder(sdb, storage, {
        orderId: paid.orderId,
        photo: { data: await cameraPhoto(), contentType: "application/pdf" },
        userId,
      }),
    ).rejects.toMatchObject({ code: "imagem_invalida" });

    expect(storage.list()).toEqual([]);
    expect(await packedEvents(paid.orderId)).toHaveLength(0);
  });
});

describe("mesa de embalagem", () => {
  it("lista só pagos/em separação sem foto, os mais antigos primeiro, com contagem de peças", async () => {
    const a = await createPaidOrder();
    const b = await createPaidOrder();
    await db
      .update(schema.orders)
      .set({ paidAt: new Date("2026-09-09T10:00:00-03:00") })
      .where(eq(schema.orders.id, b.orderId));
    await createPaidOrder({ status: "pending_payment" });

    expect(await countOrdersAwaitingPacking(sdb)).toBe(2);
    const rows = await listOrdersAwaitingPacking(sdb);
    expect(rows.map((row) => row.id)).toEqual([b.orderId, a.orderId]);
    expect(rows[0]).toMatchObject({ customerName: "Maria da Silva", itemsCount: 2, status: "paid" });

    await packOrder(sdb, storage, {
      orderId: a.orderId,
      photo: { data: await cameraPhoto(), contentType: "image/jpeg" },
      userId,
    });
    expect((await listOrdersAwaitingPacking(sdb)).map((row) => row.id)).toEqual([b.orderId]);
  });
});

describe("sendPackedWa", () => {
  it("envia a foto com a legenda uma vez; a segunda execução é 'ja_enviado'", async () => {
    await db.insert(schema.settings).values({ key: "wa_enabled", value: true });
    await seedTemplate();
    const { orderId, publicToken } = await createPaidOrder();
    await packOrder(sdb, storage, {
      orderId,
      photo: { data: await cameraPhoto(), contentType: "image/jpeg" },
      userId,
    });

    const first = await sendPackedWa(sdb, provider, storage, { orderId });
    expect(first).toMatchObject({ sent: true });
    expect(provider.sentImages).toHaveLength(1);
    expect(provider.sentImages[0].imageUrl).toMatch(
      new RegExp(`^memory://${packagePhotoStoragePath(orderId)}\\?v=\\d+$`),
    );
    expect(provider.sentImages[0].caption).toContain("Maria, sua peça foi embalada com carinho");
    expect(provider.sentImages[0].caption).toContain(publicToken);

    const messages = await db.select().from(schema.waMessages);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ kind: "image", dedupeKey: packedDedupeKey(orderId), orderId });

    expect(await sendPackedWa(sdb, provider, storage, { orderId })).toEqual({
      skipped: "ja_enviado",
    });
    expect(provider.sentImages).toHaveLength(1);
  });

  it("pula sem enviar: WhatsApp desligado, sem opt-in, sem foto, sem template", async () => {
    const { orderId } = await createPaidOrder({ marketingOptIn: false });
    expect(await sendPackedWa(sdb, provider, storage, { orderId })).toEqual({
      skipped: "desabilitado",
    });

    await db.insert(schema.settings).values({ key: "wa_enabled", value: true });
    expect(await sendPackedWa(sdb, provider, storage, { orderId })).toEqual({
      skipped: "sem_opt_in",
    });

    await db.update(schema.customers).set({ marketingOptIn: true });
    expect(await sendPackedWa(sdb, provider, storage, { orderId })).toEqual({
      skipped: "sem_foto",
    });

    await packOrder(sdb, storage, {
      orderId,
      photo: { data: await cameraPhoto(), contentType: "image/jpeg" },
      userId,
    });
    expect(await sendPackedWa(sdb, provider, storage, { orderId })).toEqual({
      skipped: "sem_template",
    });
    expect(provider.sentImages).toHaveLength(0);
  });
});
