// Saída do motoboy com GPS, com banco real (PGlite): montar a saída (o
// "Saiu" de cada pedido, o link ao motoboy, a geocodificação pela fila),
// o motoboy na rua (posições, entregue com prova, não consegui, encerrar),
// a leitura da cliente sem PII, o painel, o cancelamento e a retenção.
import { asc, eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeGeocoder } from "@/adapters/geocoding/fake";
import { FakeFileStorage } from "@/adapters/storage/fake";
import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import * as schema from "@/db/schema";
import { initialWaTemplates } from "@/db/seed-data";
import type { DbOrTx } from "@/queue/enqueue";
import { createCourier, findActiveCourierByPhone, listCouriers, updateCourier } from "@/services/couriers";
import { confirmDeliveryByToken, sendDeliveredWa } from "@/services/delivery";
import { completeDispatchedOrder, dispatchOrder, listRouteOfDay, rescheduleOrderWindow } from "@/services/delivery-routes";
import {
  canJoinDeliveryRun,
  cancelDeliveryRun,
  closeStaleDeliveryRuns,
  completeStop,
  createDeliveryRun,
  failStop,
  finishDeliveryRun,
  geocodeRunStops,
  getDeliveryRun,
  getRunForCourier,
  getStopForOrder,
  getTrackingForOrder,
  listDeliveryRuns,
  listRunEligibleOrders,
  purgeOldDeliveryPositions,
  recordRunPosition,
  resendCourierLink,
  startDeliveryRun,
} from "@/services/delivery-runs";
import { PHOTO_REQUIRED_CODE } from "@/services/delivery-runs";
import { transitionOrder } from "@/services/orders";
import { createStoreOrder, type CreateStoreOrderInput } from "@/services/store-orders";
import { createTestDb, createTestVariant, FIXED_USER_ID, type TestDb } from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;
let sdb: DbOrTx;
let storage: FakeFileStorage;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  storage = new FakeFileStorage();
});

/** A foto que o celular do motoboy manda: grande, com EXIF (endereço na descrição) — o serviço reduz e limpa. */
async function cameraPhoto(): Promise<{ data: Uint8Array; contentType: string }> {
  const data = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: "#c0a050" } })
    .jpeg({ quality: 90 })
    .withMetadata({ exif: { IFD0: { ImageDescription: "rua tal, 100" } } })
    .toBuffer();
  return { data: new Uint8Array(data), contentType: "image/jpeg" };
}

/** "Entregue" pelo motoboy com a foto obrigatória (o caso normal). */
async function deliver(input: Omit<Parameters<typeof completeStop>[2], "photo"> & { photo?: { data: Uint8Array; contentType: string } | null }) {
  return completeStop(sdb, storage, { photo: await cameraPhoto(), ...input });
}

afterEach(async () => {
  await close();
});

const VALID_CPF = "529.982.247-25";
const WINDOWS = [
  { start: "16:00", end: "19:00", cutoff: "13:00" },
  { start: "19:00", end: "21:00", cutoff: "17:00" },
];
const MORNING = new Date("2026-09-18T13:30:00Z"); // 10:30 SP, sexta 18/09
const AFTERNOON = new Date("2026-09-18T19:00:00Z"); // 16:00 SP
const TODAY = "2026-09-18";
const NAZARE = { lat: -1.4558, lng: -48.4902 };

async function activatePrice(variantId: string, priceCents: number): Promise<void> {
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

let setups = 0;
async function setup(opts: { kind?: "motoboy" | "correios" } = {}) {
  setups += 1;
  const suffix = `${opts.kind === "correios" ? "PAC" : "MOTO"}-${setups}`;
  const { variantId } = await createTestVariant(db, { sku: `LONGO-DUNAS-${suffix}`, costCents: 1200, onHand: 20, name: `Longo Dunas ${suffix}` });
  await activatePrice(variantId, 15900);
  const [rate] = await db
    .insert(schema.shippingRates)
    .values(
      opts.kind === "correios"
        ? { name: "PAC", priceCents: 1990 }
        : { name: "Motoboy Belém", priceCents: 1500, kind: "motoboy", cepStart: "66000000", cepEnd: "66999999", deliveryWindows: WINDOWS, deliveryDaysMin: 0, deliveryDaysMax: 0 },
    )
    .returning({ id: schema.shippingRates.id });
  return { variantId, rateId: rate.id };
}

/** Fora da área do motoboy: onde o motoboy chega, o pedido pelos Correios é recusado (SHIPPING_MOTOBOY_ONLY). */
const SP_ADDRESS = { postalCode: "01310-100", street: "Av. Paulista", number: "1000", complement: "", district: "Bela Vista", city: "São Paulo", state: "SP" };

function input(variantId: string, rateId: string, over: Partial<CreateStoreOrderInput> = {}): CreateStoreOrderInput {
  return {
    customer: { fullName: "Ana Souza", document: VALID_CPF, phone: "(91) 98888-1234", email: "ana@example.com", marketingOptIn: true },
    address: { postalCode: "66050-000", street: "Av. Nazaré", number: "100", complement: "apto 12", district: "Nazaré", city: "Belém", state: "PA" },
    items: [{ variantId, quantity: 1, expectedUnitPriceCents: 15900 }],
    shippingRateId: rateId,
    expectedShippingCents: 1500,
    ...over,
  };
}

/** Embalar antes de sair: a foto do pacote registrada (o que packOrder grava), sem passar pela Mesa. */
async function packed(orderId: string): Promise<void> {
  await db.update(schema.orders).set({ packagePhotoPath: `packages/${orderId}/embalagem.jpg`, packedAt: new Date() }).where(eq(schema.orders.id, orderId));
}

async function paidMotoboyOrder(variantId: string, rateId: string, dayKey = TODAY, w = WINDOWS[1], now = MORNING, opts: { packed?: boolean } = {}) {
  const created = await createStoreOrder(sdb, input(variantId, rateId, { deliveryWindow: { dayKey, ...w } }), { now });
  await transitionOrder(sdb, { orderId: created.orderId, to: "paid", userId: FIXED_USER_ID });
  if (opts.packed !== false) await packed(created.orderId);
  return created;
}

async function cashMotoboyOrder(variantId: string, rateId: string, dayKey = TODAY, w = WINDOWS[1], opts: { packed?: boolean } = {}) {
  const created = await createStoreOrder(sdb, input(variantId, rateId, { deliveryWindow: { dayKey, ...w }, paymentMethod: "cash" }), { now: MORNING });
  if (opts.packed !== false) await packed(created.orderId);
  return created;
}

async function courier(name = "Carlos Motoboy", phone = "(91) 98765-4321") {
  return createCourier(sdb, { name, phone, userId: FIXED_USER_ID });
}

async function outboxEvents() {
  return db.select().from(schema.outboxEvents).orderBy(asc(schema.outboxEvents.createdAt));
}

async function orderRow(orderId: string) {
  const [row] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId));
  return row;
}

async function stopsOf(runId: string) {
  return db.select().from(schema.deliveryStops).where(eq(schema.deliveryStops.runId, runId)).orderBy(asc(schema.deliveryStops.sequence));
}

/** Outra saída na rua (outro motoboy), para testes que precisam de duas. */
async function runOnTheRoad2() {
  const { variantId, rateId } = await setup();
  const paid = await paidMotoboyOrder(variantId, rateId);
  const cash = await cashMotoboyOrder(variantId, rateId);
  const c = await courier("Outro Motoboy", "(91) 98111-2222");
  const created = await createDeliveryRun(sdb, { courierId: c.id, orderIds: [paid.orderId, cash.orderId], userId: FIXED_USER_ID, now: AFTERNOON });
  await startDeliveryRun(sdb, { courierToken: created.courierToken, now: AFTERNOON });
  return { paid, cash, courier: c, run: created, stops: await stopsOf(created.runId), token: created.courierToken };
}

/** Uma saída na rua com um pedido pago e um em dinheiro. */
async function runOnTheRoad() {
  const { variantId, rateId } = await setup();
  const paid = await paidMotoboyOrder(variantId, rateId);
  const cash = await cashMotoboyOrder(variantId, rateId);
  const c = await courier();
  const created = await createDeliveryRun(sdb, { courierId: c.id, orderIds: [paid.orderId, cash.orderId], userId: FIXED_USER_ID, now: AFTERNOON });
  await startDeliveryRun(sdb, { courierToken: created.courierToken, now: AFTERNOON });
  const stops = await stopsOf(created.runId);
  return { paid, cash, courier: c, run: created, stops, token: created.courierToken };
}

describe("motoboys", () => {
  it("cadastra com telefone normalizado, lista os ativos, recusa duplicado e acha pelo número", async () => {
    const c = await courier("Carlos Motoboy", "91 98765 4321");
    expect(c.phoneE164).toBe("+5591987654321");
    await expect(courier("Outro", "(91) 98765-4321")).rejects.toThrow(/já existe/i);
    expect((await listCouriers(sdb)).map((x) => x.name)).toEqual(["Carlos Motoboy"]);
    expect(await findActiveCourierByPhone(sdb, "+5591987654321")).toMatchObject({ id: c.id });

    const updated = await updateCourier(sdb, { courierId: c.id, name: "Carlos Silva", isActive: false, userId: FIXED_USER_ID });
    expect(updated).toMatchObject({ name: "Carlos Silva", isActive: false });
    expect(await listCouriers(sdb)).toEqual([]);
    expect((await listCouriers(sdb, { includeInactive: true })).map((x) => x.name)).toEqual(["Carlos Silva"]);
    expect(await findActiveCourierByPhone(sdb, "+5591987654321")).toBeNull();
    await expect(createCourier(sdb, { name: "X", phone: "123", userId: FIXED_USER_ID })).rejects.toThrow(/inválido/i);
  });
});

describe("listRunEligibleOrders", () => {
  it("motoboy pago, em dinheiro, já na rua e de amanhã entram; Correios, janela passada e quem já está numa saída não (ou vem marcado)", async () => {
    const { variantId, rateId } = await setup();
    const paid = await paidMotoboyOrder(variantId, rateId);
    const cash = await cashMotoboyOrder(variantId, rateId);
    const tomorrow = await paidMotoboyOrder(variantId, rateId, "2026-09-19", WINDOWS[0]);
    const past = await paidMotoboyOrder(variantId, rateId, "2026-09-17", WINDOWS[0], new Date("2026-09-17T13:30:00Z"));
    const onStreet = await paidMotoboyOrder(variantId, rateId);
    await dispatchOrder(sdb, { orderId: onStreet.orderId, userId: FIXED_USER_ID, now: AFTERNOON });
    const correios = await setup({ kind: "correios" });
    const pac = await createStoreOrder(sdb, input(correios.variantId, correios.rateId, { expectedShippingCents: 1990, address: SP_ADDRESS }), { now: MORNING });
    await transitionOrder(sdb, { orderId: pac.orderId, to: "paid", userId: FIXED_USER_ID });

    const c = await courier();
    const created = await createDeliveryRun(sdb, { courierId: c.id, orderIds: [tomorrow.orderId], userId: FIXED_USER_ID, now: AFTERNOON });

    const eligible = await listRunEligibleOrders(sdb, { now: AFTERNOON });
    const byId = new Map(eligible.map((o) => [o.id, o]));
    expect(byId.has(paid.orderId)).toBe(true);
    expect(byId.has(cash.orderId)).toBe(true);
    expect(byId.get(onStreet.orderId)?.status).toBe("shipped");
    expect(byId.get(tomorrow.orderId)).toMatchObject({ openRunId: created.runId, openRunCourier: "Carlos Motoboy" });
    expect(byId.get(paid.orderId)).toMatchObject({ openRunId: null, openRunCourier: null });
    expect(byId.has(past.orderId)).toBe(false);
    expect(byId.has(pac.orderId)).toBe(false);
  });

  it("embalar antes de sair: pedido sem foto não é elegível (pago e dinheiro), mas quem já está na rua ou voltou para a loja sem foto continua", async () => {
    const { variantId, rateId } = await setup();
    const semFoto = await paidMotoboyOrder(variantId, rateId, TODAY, WINDOWS[1], MORNING, { packed: false });
    const cashSemFoto = await cashMotoboyOrder(variantId, rateId, TODAY, WINDOWS[1], { packed: false });
    const comFoto = await paidMotoboyOrder(variantId, rateId);
    // Saiu antes da regra: sem foto, mas já na rua.
    const naRua = await paidMotoboyOrder(variantId, rateId, TODAY, WINDOWS[1], MORNING, { packed: false });
    await db
      .update(schema.orders)
      .set({ status: "shipped", deliveryWindow: { dayKey: TODAY, ...WINDOWS[1], rateName: "Motoboy Belém", label: "hoje", dispatchedAt: AFTERNOON.toISOString() } })
      .where(eq(schema.orders.id, naRua.orderId));
    const eligible = (await listRunEligibleOrders(sdb, { now: AFTERNOON })).map((o) => o.orderNumber).sort();
    expect(eligible).toEqual([comFoto.orderNumber, naRua.orderNumber].sort());
    expect(eligible).not.toContain(semFoto.orderNumber);
    expect(eligible).not.toContain(cashSemFoto.orderNumber);
  });

  it("'Saiu' de mais de 48 h não é 'na rua': fica fora; pedido entregue pelo motoboy à espera da baixa também", async () => {
    const { variantId, rateId } = await setup();
    const old = await paidMotoboyOrder(variantId, rateId, "2026-09-15", WINDOWS[0], new Date("2026-09-15T13:30:00Z"));
    await dispatchOrder(sdb, { orderId: old.orderId, userId: FIXED_USER_ID, now: new Date("2026-09-15T19:00:00Z") });
    expect((await listRunEligibleOrders(sdb, { now: AFTERNOON })).some((o) => o.id === old.orderId)).toBe(false);

    const { cash, stops, token } = await runOnTheRoad();
    await deliver({ courierToken: token, stopId: stops.find((s) => s.orderId === cash.orderId)!.id, receivedBy: "Maria", now: AFTERNOON });
    expect((await listRunEligibleOrders(sdb, { now: AFTERNOON })).some((o) => o.id === cash.orderId)).toBe(false);
    const c2 = await courier("Outro", "(91) 98111-2222");
    await expect(createDeliveryRun(sdb, { courierId: c2.id, orderIds: [cash.orderId], userId: FIXED_USER_ID, now: AFTERNOON })).rejects.toThrow(/já foi entregue/);
  });
});

describe("canJoinDeliveryRun (a ficha: saiu sem escolher o motoboy)", () => {
  it("saiu sem motoboy pode receber um; em saída aberta, saído há mais de 48 h, Correios e entregue pelo motoboy não", async () => {
    const { variantId, rateId } = await setup();
    const semMotoboy = await paidMotoboyOrder(variantId, rateId);
    await dispatchOrder(sdb, { orderId: semMotoboy.orderId, userId: FIXED_USER_ID, now: AFTERNOON });
    expect(await canJoinDeliveryRun(sdb, { orderId: semMotoboy.orderId, now: AFTERNOON })).toBe(true);
    expect(await getTrackingForOrder(sdb, semMotoboy.publicToken, AFTERNOON)).toBeNull();

    // Escolhido o motoboy depois: a cliente não recebe outro aviso e o pedido deixa de poder entrar em outra.
    const shippedBefore = (await outboxEvents()).filter((e) => e.eventType === "order.shipped").length;
    const c = await courier();
    const created = await createDeliveryRun(sdb, { courierId: c.id, orderIds: [semMotoboy.orderId], userId: FIXED_USER_ID, now: AFTERNOON });
    expect(created.stops[0].alreadyDispatched).toBe(true);
    expect((await outboxEvents()).filter((e) => e.eventType === "order.shipped")).toHaveLength(shippedBefore);
    expect(await getTrackingForOrder(sdb, semMotoboy.publicToken, AFTERNOON)).not.toBeNull();
    expect(await canJoinDeliveryRun(sdb, { orderId: semMotoboy.orderId, now: AFTERNOON })).toBe(false);

    const old = await paidMotoboyOrder(variantId, rateId, "2026-09-15", WINDOWS[0], new Date("2026-09-15T13:30:00Z"));
    await dispatchOrder(sdb, { orderId: old.orderId, userId: FIXED_USER_ID, now: new Date("2026-09-15T19:00:00Z") });
    expect(await canJoinDeliveryRun(sdb, { orderId: old.orderId, now: AFTERNOON })).toBe(false);

    const correios = await setup({ kind: "correios" });
    const pac = await createStoreOrder(sdb, input(correios.variantId, correios.rateId, { expectedShippingCents: 1990, address: SP_ADDRESS }), { now: MORNING });
    await transitionOrder(sdb, { orderId: pac.orderId, to: "paid", userId: FIXED_USER_ID });
    expect(await canJoinDeliveryRun(sdb, { orderId: pac.orderId, now: AFTERNOON })).toBe(false);

    const { cash, stops, token } = await runOnTheRoad2();
    await deliver({ courierToken: token, stopId: stops.find((s) => s.orderId === cash.orderId)!.id, receivedBy: "Maria", now: AFTERNOON });
    expect(await canJoinDeliveryRun(sdb, { orderId: cash.orderId, now: AFTERNOON })).toBe(false);
  });
});

describe("createDeliveryRun", () => {
  it("cada pedido recebe o 'Saiu' de sempre, vira parada na ordem marcada, e o motoboy recebe o link pela fila", async () => {
    const { variantId, rateId } = await setup();
    const paid = await paidMotoboyOrder(variantId, rateId);
    const cash = await cashMotoboyOrder(variantId, rateId);
    const c = await courier();

    const created = await createDeliveryRun(sdb, { courierId: c.id, orderIds: [cash.orderId, paid.orderId], userId: FIXED_USER_ID, now: AFTERNOON });
    expect(created.courierUrl).toBe(`https://trivemaison.com.br/entrega/${created.courierToken}`);
    expect(created.stops.map((s) => [s.orderId, s.sequence, s.alreadyDispatched])).toEqual([
      [cash.orderId, 1, false],
      [paid.orderId, 2, false],
    ]);

    const stops = await stopsOf(created.runId);
    expect(stops.map((s) => [s.sequence, s.status, s.destAddress])).toEqual([
      [1, "pending", "Av. Nazaré, 100, apto 12 — Nazaré, Belém"],
      [2, "pending", "Av. Nazaré, 100, apto 12 — Nazaré, Belém"],
    ]);
    const paidRow = await orderRow(paid.orderId);
    expect(paidRow.status).toBe("shipped");
    expect(paidRow.deliveryWindow?.dispatchedAt).toBe(AFTERNOON.toISOString());
    const cashRow = await orderRow(cash.orderId);
    expect(cashRow.status).toBe("pending_payment");
    expect(cashRow.deliveryWindow?.dispatchedAt).toBe(AFTERNOON.toISOString());

    const events = await outboxEvents();
    const types = events.map((e) => e.eventType);
    expect(types.filter((t) => t === "order.shipped")).toHaveLength(1);
    expect(types.filter((t) => t === "order.out_for_delivery")).toHaveLength(1);
    const link = events.find((e) => e.eventType === "wa.send");
    expect(link?.dedupeKey).toBe(`wa.courier_link:${created.runId}`);
    const payload = link?.payload as { phoneE164: string; body: string; dedupeKey: string };
    expect(payload.phoneE164).toBe("+5591987654321");
    expect(payload.body).toContain("Oi, Carlos!");
    expect(payload.body).toContain("2 entregas");
    expect(payload.body).toContain(created.courierUrl);
    expect(payload.body).toContain("compartilha sua localização");
    const geocode = events.find((e) => e.eventType === "delivery_run.geocode");
    expect(geocode?.payload).toEqual({ runId: created.runId });
    const [run] = await db.select().from(schema.deliveryRuns).where(eq(schema.deliveryRuns.id, created.runId));
    expect(run.status).toBe("ready");
    expect(run.createdBy).toBe(FIXED_USER_ID);
  });

  it("montar saída com pedido sem foto recusa listando TODOS os números, antes de criar qualquer coisa", async () => {
    const { variantId, rateId } = await setup();
    const ok = await paidMotoboyOrder(variantId, rateId);
    const a = await paidMotoboyOrder(variantId, rateId, TODAY, WINDOWS[1], MORNING, { packed: false });
    const b = await cashMotoboyOrder(variantId, rateId, TODAY, WINDOWS[1], { packed: false });
    const c = await courier();
    await expect(createDeliveryRun(sdb, { courierId: c.id, orderIds: [ok.orderId, a.orderId, b.orderId], userId: FIXED_USER_ID, now: AFTERNOON })).rejects.toMatchObject({
      code: "NOT_PACKED",
      message: `Os pedidos #${a.orderNumber}, #${b.orderNumber} ainda não foram embalados: registre a foto do pacote (Mesa de embalagem) antes de montar a saída.`,
    });
    expect(await db.select().from(schema.deliveryRuns)).toHaveLength(0);
    expect(await db.select().from(schema.deliveryStops)).toHaveLength(0);
    expect((await orderRow(ok.orderId)).status).toBe("paid");
    expect(await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.eventType, "order.shipped"))).toHaveLength(0);

    await packed(a.orderId);
    await packed(b.orderId);
    const created = await createDeliveryRun(sdb, { courierId: c.id, orderIds: [ok.orderId, a.orderId, b.orderId], userId: FIXED_USER_ID, now: AFTERNOON });
    expect(created.stops).toHaveLength(3);
  });

  it("pedido que a dona já marcou como saído entra sem segundo aviso à cliente", async () => {
    const { variantId, rateId } = await setup();
    const paid = await paidMotoboyOrder(variantId, rateId);
    await dispatchOrder(sdb, { orderId: paid.orderId, userId: FIXED_USER_ID, now: AFTERNOON });
    const before = (await outboxEvents()).filter((e) => e.eventType === "order.shipped").length;
    const c = await courier();
    const created = await createDeliveryRun(sdb, { courierId: c.id, orderIds: [paid.orderId], userId: FIXED_USER_ID, now: AFTERNOON });
    expect(created.stops[0].alreadyDispatched).toBe(true);
    expect((await outboxEvents()).filter((e) => e.eventType === "order.shipped")).toHaveLength(before);
  });

  it("recusa Correios (e desfaz tudo), pedido já numa saída aberta, motoboy desativado, janela passada e lista vazia", async () => {
    const { variantId, rateId } = await setup();
    const paid = await paidMotoboyOrder(variantId, rateId);
    const correios = await setup({ kind: "correios" });
    const pac = await createStoreOrder(sdb, input(correios.variantId, correios.rateId, { expectedShippingCents: 1990, address: SP_ADDRESS }), { now: MORNING });
    await transitionOrder(sdb, { orderId: pac.orderId, to: "paid", userId: FIXED_USER_ID });
    await packed(pac.orderId);
    const c = await courier();

    await expect(createDeliveryRun(sdb, { courierId: c.id, orderIds: [paid.orderId, pac.orderId], userId: FIXED_USER_ID, now: AFTERNOON })).rejects.toThrow(/não é de motoboy/);
    expect(await db.select().from(schema.deliveryRuns)).toHaveLength(0);
    expect((await orderRow(paid.orderId)).status).toBe("paid");

    await createDeliveryRun(sdb, { courierId: c.id, orderIds: [paid.orderId], userId: FIXED_USER_ID, now: AFTERNOON });
    await expect(createDeliveryRun(sdb, { courierId: c.id, orderIds: [paid.orderId], userId: FIXED_USER_ID, now: AFTERNOON })).rejects.toThrow(/já está numa saída/);

    const past = await paidMotoboyOrder(variantId, rateId, "2026-09-17", WINDOWS[0], new Date("2026-09-17T13:30:00Z"));
    await expect(createDeliveryRun(sdb, { courierId: c.id, orderIds: [past.orderId], userId: FIXED_USER_ID, now: AFTERNOON })).rejects.toThrow(/já passou/);

    await updateCourier(sdb, { courierId: c.id, isActive: false, userId: FIXED_USER_ID });
    const other = await paidMotoboyOrder(variantId, rateId);
    await expect(createDeliveryRun(sdb, { courierId: c.id, orderIds: [other.orderId], userId: FIXED_USER_ID, now: AFTERNOON })).rejects.toThrow(/desativado/);
    await expect(createDeliveryRun(sdb, { courierId: c.id, orderIds: [], userId: FIXED_USER_ID })).rejects.toThrow();
  });

  it("reenvia o link com outra chave de dedupe — nunca a motoboy desativado", async () => {
    const { run, courier: c } = await runOnTheRoad();
    await resendCourierLink(sdb, { runId: run.runId, userId: FIXED_USER_ID, now: new Date(AFTERNOON.getTime() + 60_000) });
    const links = (await outboxEvents()).filter((e) => e.eventType === "wa.send");
    expect(links).toHaveLength(2);
    expect(links[1].dedupeKey).toBe(`wa.courier_link:${run.runId}:${AFTERNOON.getTime() + 60_000}`);
    await updateCourier(sdb, { courierId: c.id, isActive: false, userId: FIXED_USER_ID });
    await expect(resendCourierLink(sdb, { runId: run.runId, userId: FIXED_USER_ID })).rejects.toThrow(/desativado/);
    expect((await outboxEvents()).filter((e) => e.eventType === "wa.send")).toHaveLength(2);
  });
});

describe("o motoboy na rua", () => {
  it("'Comecei a rota' abre a saída (idempotente); token errado não existe", async () => {
    const { variantId, rateId } = await setup();
    const paid = await paidMotoboyOrder(variantId, rateId);
    const c = await courier();
    const created = await createDeliveryRun(sdb, { courierId: c.id, orderIds: [paid.orderId], userId: FIXED_USER_ID, now: AFTERNOON });
    expect(await startDeliveryRun(sdb, { courierToken: created.courierToken, now: AFTERNOON })).toEqual({ runId: created.runId, idempotent: false });
    expect(await startDeliveryRun(sdb, { courierToken: created.courierToken })).toEqual({ runId: created.runId, idempotent: true });
    const [run] = await db.select().from(schema.deliveryRuns).where(eq(schema.deliveryRuns.id, created.runId));
    expect(run.status).toBe("en_route");
    expect(run.startedAt).toEqual(AFTERNOON);
    await expect(startDeliveryRun(sdb, { courierToken: "nao-e-uuid" })).rejects.toThrow(/não encontrada/);
    await expect(startDeliveryRun(sdb, { courierToken: "00000000-0000-4000-8000-000000000000" })).rejects.toThrow(/não encontrada/);
  });

  it("posições: só na rua; a última sempre atualiza (hora do servidor), a trilha com espaçamento; regressão é recusada", async () => {
    const { variantId, rateId } = await setup();
    const paid = await paidMotoboyOrder(variantId, rateId);
    const c = await courier();
    const created = await createDeliveryRun(sdb, { courierId: c.id, orderIds: [paid.orderId], userId: FIXED_USER_ID, now: AFTERNOON });
    const token = created.courierToken;
    const t = (s: number) => new Date(AFTERNOON.getTime() + s * 1000);

    expect(await recordRunPosition(sdb, { courierToken: token, lat: -1.45, lng: -48.49, accuracyM: 10, recordedAt: t(0), now: t(0) })).toEqual({ accepted: false, reason: "not_en_route" });
    await startDeliveryRun(sdb, { courierToken: token, now: t(0) });

    expect(await recordRunPosition(sdb, { courierToken: token, lat: -1.45, lng: -48.49, accuracyM: 10, recordedAt: t(1), now: t(1) })).toEqual({ accepted: true, trail: true });
    // 5 s depois, 5 m adiante: a última posição muda, a trilha não.
    expect(await recordRunPosition(sdb, { courierToken: token, lat: -1.45 + 5 / 111_320, lng: -48.49, accuracyM: 10, recordedAt: t(6), now: t(6) })).toEqual({ accepted: true, trail: false });
    expect(await recordRunPosition(sdb, { courierToken: token, lat: -1.45, lng: -48.49, accuracyM: 10, recordedAt: t(0), now: t(7) })).toEqual({ accepted: false, reason: "regression" });
    // 20 s depois: trilha por tempo. Relógio do celular 8 min adiantado: a hora é aparada ao servidor.
    expect(await recordRunPosition(sdb, { courierToken: token, lat: -1.451, lng: -48.49, accuracyM: 25, speedMps: 8, recordedAt: t(500), now: t(26) })).toEqual({ accepted: true, trail: true });

    const [run] = await db.select().from(schema.deliveryRuns).where(eq(schema.deliveryRuns.id, created.runId));
    expect(run.lastLat).toBeCloseTo(-1.451, 6);
    expect(run.lastPositionAt).toEqual(t(26));
    expect(run.lastAccuracyM).toBe(25);
    const trail = await db.select().from(schema.deliveryPositions).where(eq(schema.deliveryPositions.runId, created.runId)).orderBy(asc(schema.deliveryPositions.recordedAt));
    expect(trail.map((p) => p.recordedAt)).toEqual([t(1), t(26)]);
    expect(trail[1].speedMps).toBe(8);
  });

  it("relógio do celular 5 min atrasado: o sinal é 'ao vivo' mesmo assim (hora de chegada ao servidor)", async () => {
    const { paid, token } = await runOnTheRoad();
    const t = (s: number) => new Date(AFTERNOON.getTime() + s * 1000);
    expect(await recordRunPosition(sdb, { courierToken: token, lat: NAZARE.lat + 0.001, lng: NAZARE.lng, accuracyM: 8, recordedAt: t(-300), now: t(10) })).toMatchObject({ accepted: true });
    const view = (await getTrackingForOrder(sdb, paid.publicToken, t(15)))!;
    expect(view.signal).toBe("live");
    expect(view.updatedSecondsAgo).toBe(5);
  });

  it("'Entregue' no pedido pago: prova na parada e no pedido, 'delivered' pela máquina e o aviso com hora e quem recebeu", async () => {
    const { paid, stops, token, courier: c } = await runOnTheRoad();
    const paidStop = stops.find((s) => s.orderId === paid.orderId)!;
    const at = new Date(AFTERNOON.getTime() + 20 * 60_000);

    const result = await deliver({ courierToken: token, stopId: paidStop.id, receivedBy: "Maria Aparecida", position: { lat: -1.4559, lng: -48.4901, accuracyM: 9 }, now: at });
    expect(result).toMatchObject({ orderId: paid.orderId, orderDelivered: true, awaitingCash: false, receivedBy: "Maria", idempotent: false });

    const [stop] = await db.select().from(schema.deliveryStops).where(eq(schema.deliveryStops.id, paidStop.id));
    expect(stop).toMatchObject({ status: "delivered", deliveredAt: at, receivedBy: "Maria", deliveredLat: -1.4559, deliveredLng: -48.4901, deliveredAccuracyM: 9 });
    const order = await orderRow(paid.orderId);
    expect(order).toMatchObject({ status: "delivered", receivedBy: "Maria", deliveryConfirmedBy: "courier" });
    expect(order.deliveredAt).not.toBeNull();
    // A hora real da entrega vira um evento (quem decide o atraso é o handler), um por parada.
    const stopDelivered = (await outboxEvents()).filter((e) => e.eventType === "delivery.stop_delivered");
    expect(stopDelivered).toHaveLength(1);
    expect(stopDelivered[0].payload).toEqual({ orderId: paid.orderId, stopId: paidStop.id });
    expect((await outboxEvents()).some((e) => e.eventType === "order.delivered" && e.aggregateId === paid.orderId)).toBe(true);
    const history = await db.select().from(schema.orderStatusHistory).where(eq(schema.orderStatusHistory.orderId, paid.orderId));
    expect(history.some((h) => h.toStatus === "delivered" && h.reason?.includes(c.name))).toBe(true);

    // A foto da entrega: reduzida, sem EXIF, no path do pedido — e o aviso à cliente sai COM a foto, hora e quem recebeu.
    expect(result.withPhoto).toBe(true);
    expect(order.deliveredPhotoPath).toBe(`deliveries/${paid.orderId}/entrega-motoboy.jpg`);
    const stored = storage.get(`deliveries/${paid.orderId}/entrega-motoboy.jpg`)!;
    const meta = await sharp(Buffer.from(stored.data)).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(1200);
    expect(meta.exif).toBeUndefined();
    await db.insert(schema.settings).values({ key: "wa_enabled", value: true });
    const template = initialWaTemplates.find((row) => row.key === "order_delivered")!;
    await db.insert(schema.waTemplates).values({ key: template.key, label: template.label, bodyTemplate: template.bodyTemplate, variables: template.variables });
    const provider = new FakeMessagingProvider();
    const sent = await sendDeliveredWa(sdb, provider, storage, { orderId: paid.orderId, now: at });
    expect(sent).toMatchObject({ withPhoto: true });
    // A imagem vai com a legenda; a hora é a da transição (relógio real) e o nome vem da parada.
    expect(provider.sentImages).toHaveLength(1);
    expect(provider.sentImages[0].imageUrl).toContain(`deliveries/${paid.orderId}/entrega-motoboy.jpg`);
    expect(provider.sentImages[0].caption).toMatch(/às \d{2}:\d{2}, recebido por Maria/);

    // Segundo toque (até sem foto): nada muda e nada sobe de novo.
    const uploads = storage.list().length;
    expect(await completeStop(sdb, storage, { courierToken: token, stopId: paidStop.id, receivedBy: "Outra", now: at })).toMatchObject({ idempotent: true, receivedBy: "Maria", withPhoto: true });
    expect(storage.list().length).toBe(uploads);
    expect(await getStopForOrder(sdb, paid.orderId)).toMatchObject({ stopStatus: "delivered", receivedBy: "Maria", courierName: c.name, deliveredPoint: { lat: -1.4559, lng: -48.4901, accuracyM: 9 }, withPhoto: true });
  });

  it("'Entregue' no pedido em dinheiro: a prova fica, o pedido espera a dona registrar o pagamento", async () => {
    const { cash, stops, token } = await runOnTheRoad();
    const cashStop = stops.find((s) => s.orderId === cash.orderId)!;
    const result = await deliver({ courierToken: token, stopId: cashStop.id, receivedBy: "a própria", now: AFTERNOON });
    expect(result).toMatchObject({ awaitingCash: true, orderDelivered: false, receivedBy: null, withPhoto: true });
    const order = await orderRow(cash.orderId);
    expect(order).toMatchObject({ status: "pending_payment", deliveryConfirmedBy: "courier", receivedBy: null, deliveredPhotoPath: `deliveries/${cash.orderId}/entrega-motoboy.jpg` });
    expect((await outboxEvents()).some((e) => e.eventType === "order.delivered")).toBe(false);

    // A dona baixa o dinheiro e fecha pelo caminho de sempre — horas depois.
    await transitionOrder(sdb, { orderId: cash.orderId, to: "paid", userId: FIXED_USER_ID });
    await completeDispatchedOrder(sdb, { orderId: cash.orderId, userId: FIXED_USER_ID });
    expect((await orderRow(cash.orderId)).status).toBe("delivered");

    // O aviso à cliente traz a hora em que o motoboy entregou (16:00 SP), não a do fechamento.
    await db.insert(schema.settings).values({ key: "wa_enabled", value: true });
    const template = initialWaTemplates.find((row) => row.key === "order_delivered")!;
    await db.insert(schema.waTemplates).values({ key: template.key, label: template.label, bodyTemplate: template.bodyTemplate, variables: template.variables });
    const provider = new FakeMessagingProvider();
    const sent = await sendDeliveredWa(sdb, provider, storage, { orderId: cash.orderId, now: new Date(AFTERNOON.getTime() + 5 * 3_600_000) });
    expect(sent).toMatchObject({ withPhoto: true });
    expect(provider.sentImages[0].caption).toMatch(/hoje às 16:00/);
  });

  it("a cliente tocou 'Chegou!' antes: a parada fecha com a foto guardada, sem sobrescrever quem confirmou e sem segunda mensagem", async () => {
    const { paid, stops, token } = await runOnTheRoad();
    await confirmDeliveryByToken(sdb, { publicToken: paid.publicToken });
    expect(await orderRow(paid.orderId)).toMatchObject({ status: "delivered", deliveryConfirmedBy: "customer" });
    // O aviso em texto já saiu quando ela confirmou.
    await db.insert(schema.settings).values({ key: "wa_enabled", value: true });
    const template = initialWaTemplates.find((row) => row.key === "order_delivered")!;
    await db.insert(schema.waTemplates).values({ key: template.key, label: template.label, bodyTemplate: template.bodyTemplate, variables: template.variables });
    const provider = new FakeMessagingProvider();
    expect(await sendDeliveredWa(sdb, provider, storage, { orderId: paid.orderId, now: AFTERNOON })).toMatchObject({ withPhoto: false });
    expect(provider.sentMessages).toHaveLength(1);

    const paidStop = stops.find((s) => s.orderId === paid.orderId)!;
    const result = await deliver({ courierToken: token, stopId: paidStop.id, receivedBy: "Maria", now: AFTERNOON });
    expect(result).toMatchObject({ orderDelivered: true, idempotent: false, receivedBy: "Maria", withPhoto: true });
    expect(await orderRow(paid.orderId)).toMatchObject({ status: "delivered", deliveryConfirmedBy: "customer", receivedBy: "Maria", deliveredPhotoPath: `deliveries/${paid.orderId}/entrega-motoboy.jpg` });
    expect(storage.has(`deliveries/${paid.orderId}/entrega-motoboy.jpg`)).toBe(true);
    // Um só order.delivered (o da cliente) e nenhuma segunda mensagem: a foto fica na página do pedido.
    expect((await outboxEvents()).filter((e) => e.eventType === "order.delivered" && e.aggregateId === paid.orderId)).toHaveLength(1);
    expect(await sendDeliveredWa(sdb, provider, storage, { orderId: paid.orderId, now: AFTERNOON })).toHaveProperty("skipped");
    expect(provider.sentMessages).toHaveLength(1);
    expect(provider.sentImages).toHaveLength(0);
  });

  it("sem a foto a parada não fecha: nada gravado, nada enviado", async () => {
    const { paid, stops, token } = await runOnTheRoad();
    const paidStop = stops.find((s) => s.orderId === paid.orderId)!;
    await expect(completeStop(sdb, storage, { courierToken: token, stopId: paidStop.id, receivedBy: "Maria", photo: null, now: AFTERNOON })).rejects.toMatchObject({ code: PHOTO_REQUIRED_CODE });
    await expect(completeStop(sdb, storage, { courierToken: token, stopId: paidStop.id, receivedBy: "Maria", now: AFTERNOON })).rejects.toMatchObject({ code: PHOTO_REQUIRED_CODE });
    await expect(
      completeStop(sdb, storage, { courierToken: token, stopId: paidStop.id, photo: { data: new Uint8Array([1, 2, 3]), contentType: "application/pdf" }, now: AFTERNOON }),
    ).rejects.toMatchObject({ code: "imagem_invalida" });
    const [stop] = await db.select().from(schema.deliveryStops).where(eq(schema.deliveryStops.id, paidStop.id));
    expect(stop.status).toBe("pending");
    expect((await orderRow(paid.orderId)).status).toBe("shipped");
    expect(storage.list()).toHaveLength(0);
    expect((await outboxEvents()).some((e) => e.eventType === "order.delivered")).toBe(false);
  });

  it("foto que a dona já tinha tirado não é sobrescrita pela do motoboy", async () => {
    const { paid, stops, token } = await runOnTheRoad();
    const paidStop = stops.find((s) => s.orderId === paid.orderId)!;
    const ownerPhoto = new Uint8Array([9, 9, 9]);
    await storage.upload({ path: `deliveries/${paid.orderId}/entrega.jpg`, data: ownerPhoto, contentType: "image/jpeg" });
    await db.update(schema.orders).set({ deliveredPhotoPath: `deliveries/${paid.orderId}/entrega.jpg` }).where(eq(schema.orders.id, paid.orderId));

    const result = await deliver({ courierToken: token, stopId: paidStop.id, receivedBy: "Maria", now: AFTERNOON });
    expect(result).toMatchObject({ orderDelivered: true, withPhoto: true });
    expect(Array.from(storage.get(`deliveries/${paid.orderId}/entrega.jpg`)!.data)).toEqual([9, 9, 9]);
    expect((await orderRow(paid.orderId)).deliveredPhotoPath).toBe(`deliveries/${paid.orderId}/entrega.jpg`);
    expect(storage.list()).toHaveLength(1);
  });

  it("recusa antes de subir a foto: saída que não começou ou pedido cancelado não deixam arquivo órfão", async () => {
    const { variantId, rateId } = await setup();
    const paid = await paidMotoboyOrder(variantId, rateId);
    const c = await courier("Outro Motoboy", "(91) 98111-2222");
    const created = await createDeliveryRun(sdb, { courierId: c.id, orderIds: [paid.orderId], userId: FIXED_USER_ID, now: AFTERNOON });
    const [stop] = await stopsOf(created.runId);
    await expect(deliver({ courierToken: created.courierToken, stopId: stop.id })).rejects.toThrow(/Comecei a rota/);
    expect(storage.list()).toHaveLength(0);

    const road = await runOnTheRoad();
    await transitionOrder(sdb, { orderId: road.paid.orderId, to: "refunded", userId: FIXED_USER_ID, reason: "Cliente desistiu." });
    await expect(deliver({ courierToken: road.token, stopId: road.stops.find((s) => s.orderId === road.paid.orderId)!.id })).rejects.toThrow(/cancelado pela loja/);
    expect(storage.list()).toHaveLength(0);
  });

  it("pedido cancelado pela loja com parada aberta: 'Entregue' recusa com mensagem clara; 'Não consegui' fecha", async () => {
    const { paid, stops, token } = await runOnTheRoad();
    await transitionOrder(sdb, { orderId: paid.orderId, to: "refunded", userId: FIXED_USER_ID, reason: "Cliente desistiu." });
    const paidStop = stops.find((s) => s.orderId === paid.orderId)!;
    await expect(deliver({ courierToken: token, stopId: paidStop.id, receivedBy: "Maria" })).rejects.toThrow(/cancelado pela loja/);
    expect(await failStop(sdb, { courierToken: token, stopId: paidStop.id, reason: "outro", note: "Loja cancelou" })).toMatchObject({ idempotent: false });
  });

  it("depois de cancelada, o link do motoboy não faz mais nada (mensagem clara, não erro genérico)", async () => {
    const { paid, stops, token, run } = await runOnTheRoad();
    await cancelDeliveryRun(sdb, { runId: run.runId, userId: FIXED_USER_ID });
    const paidStop = stops.find((s) => s.orderId === paid.orderId)!;
    await expect(startDeliveryRun(sdb, { courierToken: token })).rejects.toThrow(/cancelada pela loja/);
    await expect(deliver({ courierToken: token, stopId: paidStop.id })).rejects.toThrow(/cancelada pela loja/);
    await expect(failStop(sdb, { courierToken: token, stopId: paidStop.id, reason: "outro" })).rejects.toThrow(/cancelada pela loja/);
    expect(await recordRunPosition(sdb, { courierToken: token, lat: -1.45, lng: -48.49, recordedAt: AFTERNOON })).toEqual({ accepted: false, reason: "not_en_route" });
  });

  it("antes de 'Comecei a rota' não fecha parada; parada de outra saída não existe", async () => {
    const { variantId, rateId } = await setup();
    const paid = await paidMotoboyOrder(variantId, rateId);
    const c = await courier("Outro Motoboy", "(91) 98111-2222");
    const created = await createDeliveryRun(sdb, { courierId: c.id, orderIds: [paid.orderId], userId: FIXED_USER_ID, now: AFTERNOON });
    const [stop] = await stopsOf(created.runId);
    await expect(deliver({ courierToken: created.courierToken, stopId: stop.id })).rejects.toThrow(/Comecei a rota/);
    const other = await runOnTheRoad();
    await expect(deliver({ courierToken: other.token, stopId: stop.id })).rejects.toThrow(/não encontrada/);
  });

  it("'Não consegui': a parada falha, a dona é avisada com o motivo e o pedido fica como está", async () => {
    const { paid, stops, token } = await runOnTheRoad();
    const paidStop = stops.find((s) => s.orderId === paid.orderId)!;
    const result = await failStop(sdb, { courierToken: token, stopId: paidStop.id, reason: "ninguem_em_casa", note: "Porteiro disse que ela volta às 20h", now: AFTERNOON });
    expect(result).toMatchObject({ stopId: paidStop.id, idempotent: false });
    const [stop] = await db.select().from(schema.deliveryStops).where(eq(schema.deliveryStops.id, paidStop.id));
    expect(stop).toMatchObject({ status: "failed", failureReason: "ninguem_em_casa", failureNote: "Porteiro disse que ela volta às 20h" });
    expect((await orderRow(paid.orderId)).status).toBe("shipped");
    const alert = (await outboxEvents()).find((e) => e.eventType === "wa.owner_forward");
    expect(alert?.dedupeKey).toBe(`wa.stop_failed:${paidStop.id}`);
    const payload = alert?.payload as { body: string; raw: boolean };
    expect(payload.raw).toBe(true);
    expect(payload.body).toContain(`não conseguiu entregar o pedido #${result.orderNumber} (Ana)`);
    expect(payload.body).toContain("Ninguém em casa");
    expect(payload.body).toContain("Porteiro disse");
    expect(await failStop(sdb, { courierToken: token, stopId: paidStop.id, reason: "outro" })).toMatchObject({ idempotent: true });
    expect(await getStopForOrder(sdb, paid.orderId)).toMatchObject({ stopStatus: "failed", failureReason: "ninguem_em_casa" });
  });

  it("encerrar exige todas as paradas fechadas; depois a página do motoboy fica vazia", async () => {
    const { paid, cash, stops, token, run } = await runOnTheRoad();
    await expect(finishDeliveryRun(sdb, { courierToken: token })).rejects.toThrow(/parada por entregar/);
    await deliver({ courierToken: token, stopId: stops.find((s) => s.orderId === paid.orderId)!.id, receivedBy: "Maria", now: AFTERNOON });
    expect((await getRunForCourier(sdb, token))?.canFinish).toBe(false);
    await failStop(sdb, { courierToken: token, stopId: stops.find((s) => s.orderId === cash.orderId)!.id, reason: "cliente_pediu_outro_dia" });
    expect((await getRunForCourier(sdb, token))?.canFinish).toBe(true);
    const at = new Date(AFTERNOON.getTime() + 3_600_000);
    expect(await finishDeliveryRun(sdb, { courierToken: token, now: at })).toEqual({ runId: run.runId, idempotent: false });
    expect(await finishDeliveryRun(sdb, { runId: run.runId, userId: FIXED_USER_ID })).toEqual({ runId: run.runId, idempotent: true });
    const view = await getRunForCourier(sdb, token);
    expect(view).toMatchObject({ status: "finished", stops: [], canFinish: false });
    expect(await recordRunPosition(sdb, { courierToken: token, lat: -1.45, lng: -48.49, recordedAt: at, now: at })).toEqual({ accepted: false, reason: "not_en_route" });
  });

  it("cancelar pelo painel fecha as paradas por entregar, mata o rastreio e NÃO desfaz o 'Saiu'", async () => {
    const { paid, cash, stops, token, run } = await runOnTheRoad();
    await deliver({ courierToken: token, stopId: stops.find((s) => s.orderId === paid.orderId)!.id, now: AFTERNOON });
    expect(await cancelDeliveryRun(sdb, { runId: run.runId, userId: FIXED_USER_ID, now: AFTERNOON })).toEqual({ runId: run.runId, idempotent: false });
    const after = await stopsOf(run.runId);
    expect(after.map((s) => [s.orderId, s.status])).toEqual(
      expect.arrayContaining([
        [paid.orderId, "delivered"],
        [cash.orderId, "canceled"],
      ]),
    );
    expect((await orderRow(cash.orderId)).deliveryWindow?.dispatchedAt).toBeTruthy();
    expect(await getTrackingForOrder(sdb, cash.publicToken, AFTERNOON)).toBeNull();
    expect((await getTrackingForOrder(sdb, paid.publicToken, AFTERNOON))?.state).toBe("delivered");
    expect(await cancelDeliveryRun(sdb, { runId: run.runId, userId: FIXED_USER_ID })).toEqual({ runId: run.runId, idempotent: true });
    // Cancelado, o pedido em dinheiro volta a ser elegível para outra saída.
    expect((await listRunEligibleOrders(sdb, { now: AFTERNOON })).find((o) => o.id === cash.orderId)?.openRunId).toBeNull();
  });
});

describe("leituras", () => {
  it("a página do motoboy: paradas com endereço, navegação, janela, itens, dinheiro a receber; token inválido é null", async () => {
    const { paid, cash, token, courier: c } = await runOnTheRoad();
    const view = (await getRunForCourier(sdb, token))!;
    expect(view).toMatchObject({ status: "en_route", courierName: c.name, storeName: "TRIVÉ", canFinish: false });
    expect(view.stops).toHaveLength(2);
    const paidStop = view.stops.find((s) => s.orderNumber === paid.orderNumber)!;
    expect(paidStop).toMatchObject({
      sequence: 1,
      status: "pending",
      customerName: "Ana Souza",
      phoneE164: "+5591988881234",
      addressLine: "Av. Nazaré, 100, apto 12 — Nazaré, Belém",
      postalCode: "66050000",
      windowLabel: expect.stringContaining("19h"),
      itemsCount: 1,
      collectCashCents: null,
      isGift: false,
    });
    expect(paidStop.itemsSummary[0]).toContain("Longo Dunas MOTO");
    expect(paidStop.navigation?.waze).toContain("waze.com/ul?q=");
    expect(paidStop.navigation?.googleMaps).toContain("google.com/maps/dir/");
    const cashStop = view.stops.find((s) => s.orderNumber === cash.orderNumber)!;
    expect(cashStop.collectCashCents).toBe(15900 + 1500);
    expect(await getRunForCourier(sdb, "x")).toBeNull();
    expect(await getRunForCourier(sdb, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("a leitura da cliente: esperando → a caminho com distância e ETA (destino geocodificado pela fila) → chegando; nunca o endereço", async () => {
    const { variantId, rateId } = await setup();
    const paid = await paidMotoboyOrder(variantId, rateId);
    const other = await paidMotoboyOrder(variantId, rateId);
    const c = await courier();
    const created = await createDeliveryRun(sdb, { courierId: c.id, orderIds: [other.orderId, paid.orderId], userId: FIXED_USER_ID, now: AFTERNOON });
    const t = (s: number) => new Date(AFTERNOON.getTime() + s * 1000);

    expect(await getTrackingForOrder(sdb, paid.publicToken, t(0))).toMatchObject({ state: "waiting", courierFirstName: "Carlos", courier: null, otherStopsPending: 1 });

    const geocoder = new FakeGeocoder();
    const sleeps: number[] = [];
    expect(await geocodeRunStops(sdb, geocoder, { runId: created.runId, sleep: async (ms) => void sleeps.push(ms) })).toMatchObject({ attempted: 2, found: 2, remaining: 0, runOpen: true });
    expect(sleeps).toEqual([1100]);
    // Rodar de novo não consulta o vendor.
    expect(await geocodeRunStops(sdb, geocoder, { runId: created.runId })).toMatchObject({ attempted: 0, found: 0, remaining: 0 });
    expect(geocoder.calls).toHaveLength(2);

    await startDeliveryRun(sdb, { courierToken: created.courierToken, now: t(1) });
    expect(await getTrackingForOrder(sdb, paid.publicToken, t(2))).toMatchObject({ state: "en_route", signal: "none", courier: null });

    // ≈ 2,2 km ao norte do destino.
    await recordRunPosition(sdb, { courierToken: created.courierToken, lat: NAZARE.lat + 0.02, lng: NAZARE.lng, accuracyM: 12, recordedAt: t(10), now: t(10) });
    const far = (await getTrackingForOrder(sdb, paid.publicToken, t(25)))!;
    expect(far).toMatchObject({ state: "en_route", signal: "live", updatedSecondsAgo: 15, otherStopsPending: 1 });
    // Outra parada por entregar: posição arredondada (~110 m).
    expect(far.approximate).toBe(true);
    expect(far.courier?.accuracyM).toBe(12);
    expect(far.courier?.lat).toBeCloseTo(NAZARE.lat + 0.02, 2);
    expect(far.distanceKm).toBeCloseTo(2.2, 1);
    expect(far.etaMinutes).toBeGreaterThan(0);
    expect(JSON.stringify(far)).not.toContain("Nazaré");
    expect(JSON.stringify(far)).not.toContain(String(NAZARE.lat));

    await recordRunPosition(sdb, { courierToken: created.courierToken, lat: NAZARE.lat + 0.001, lng: NAZARE.lng, accuracyM: 8, recordedAt: t(400), now: t(400) });
    expect(await getTrackingForOrder(sdb, paid.publicToken, t(405))).toMatchObject({ state: "arriving", etaMinutes: null });
    // Sem sinal há 10 min: continua "a caminho", com a posição velha e o aviso.
    expect(await getTrackingForOrder(sdb, paid.publicToken, t(1_100))).toMatchObject({ state: "en_route", signal: "lost" });
    // Depois de 30 min sem sinal, a posição some do link.
    expect((await getTrackingForOrder(sdb, paid.publicToken, t(400 + 31 * 60)))!).toMatchObject({ state: "en_route", signal: "lost", courier: null });
    expect(await getTrackingForOrder(sdb, "nao-e-uuid")).toBeNull();
    expect(await getTrackingForOrder(sdb, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("privacidade: com outra parada por entregar a posição vai arredondada; sozinha, exata; nunca o endereço nem o destino, em nenhum estado", async () => {
    const { variantId, rateId } = await setup();
    const a = await paidMotoboyOrder(variantId, rateId);
    const b = await createStoreOrder(
      sdb,
      input(variantId, rateId, {
        customer: { fullName: "Beatriz Lima", document: "111.444.777-35", phone: "(91) 98888-5678", email: "bia@example.com", marketingOptIn: true },
        address: { postalCode: "66055-260", street: "Travessa Quintino Bocaiúva", number: "1500", complement: "", district: "Batista Campos", city: "Belém", state: "PA" },
        deliveryWindow: { dayKey: TODAY, ...WINDOWS[1] },
      }),
      { now: MORNING },
    );
    await transitionOrder(sdb, { orderId: b.orderId, to: "paid", userId: FIXED_USER_ID });
    await packed(b.orderId);
    const c = await courier();
    const created = await createDeliveryRun(sdb, { courierId: c.id, orderIds: [a.orderId, b.orderId], userId: FIXED_USER_ID, now: AFTERNOON });
    const geocoder = new FakeGeocoder();
    geocoder.set("Travessa Quintino Bocaiúva", { lat: -1.4611, lng: -48.4867 });
    await geocodeRunStops(sdb, geocoder, { runId: created.runId, sleep: async () => {} });
    await startDeliveryRun(sdb, { courierToken: created.courierToken, now: AFTERNOON });
    const t = (s: number) => new Date(AFTERNOON.getTime() + s * 1000);
    // O motoboy parado na porta da cliente A (ponto exato da casa dela).
    const atA = { lat: NAZARE.lat + 0.00004, lng: NAZARE.lng - 0.00007 };
    await recordRunPosition(sdb, { courierToken: created.courierToken, ...atA, accuracyM: 6, recordedAt: t(30), now: t(30) });

    const seenByB = (await getTrackingForOrder(sdb, b.publicToken, t(35)))!;
    expect(seenByB.approximate).toBe(true);
    expect(seenByB.courier).not.toEqual({ ...atA, accuracyM: 6 });
    expect(Math.abs(seenByB.courier!.lat - atA.lat)).toBeLessThanOrEqual(0.001);
    const seenByA = (await getTrackingForOrder(sdb, a.publicToken, t(35)))!;
    expect(seenByA.state).toBe("arriving");
    expect(seenByA.approximate).toBe(true); // B ainda por entregar

    const stops = await stopsOf(created.runId);
    await deliver({ courierToken: created.courierToken, stopId: stops.find((s) => s.orderId === a.orderId)!.id, receivedBy: "Ana", position: { ...atA, accuracyM: 6 }, now: t(60) });
    // A acabou de fechar e o motoboy ainda está na porta dela: para B continua arredondada por 10 min.
    await recordRunPosition(sdb, { courierToken: created.courierToken, ...atA, accuracyM: 6, recordedAt: t(90), now: t(90) });
    const grace = (await getTrackingForOrder(sdb, b.publicToken, t(95)))!;
    expect(grace.approximate).toBe(true);
    expect(grace.courier).not.toEqual({ ...atA, accuracyM: 6 });
    // 11 min depois, só B sobrou e a carência passou: posição exata para B.
    const late = 60 + 11 * 60;
    await recordRunPosition(sdb, { courierToken: created.courierToken, lat: -1.4605, lng: -48.4871, accuracyM: 6, recordedAt: t(late), now: t(late) });
    const alone = (await getTrackingForOrder(sdb, b.publicToken, t(late + 5)))!;
    expect(alone.approximate).toBe(false);
    expect(alone.courier).toEqual({ lat: -1.4605, lng: -48.4871, accuracyM: 6 });

    // Em nenhum estado a leitura carrega endereço ou destino.
    const forbidden = ["Nazaré", "Quintino", "-1.4611", "-48.4867", String(NAZARE.lat), "destination", "address"];
    for (const [token, when] of [[a.publicToken, t(65)], [b.publicToken, t(late + 5)]] as const) {
      const json = JSON.stringify(await getTrackingForOrder(sdb, token, when));
      for (const word of forbidden) expect(json).not.toContain(word);
    }
    await failStop(sdb, { courierToken: created.courierToken, stopId: stops.find((s) => s.orderId === b.orderId)!.id, reason: "ninguem_em_casa" });
    expect((await getTrackingForOrder(sdb, b.publicToken, t(300)))!).toMatchObject({ state: "failed", courier: null });
    await finishDeliveryRun(sdb, { courierToken: created.courierToken, now: t(400) });
    expect((await getTrackingForOrder(sdb, a.publicToken, t(500)))!).toMatchObject({ state: "delivered", courier: null, receivedBy: "Ana" });
  });

  it("geocodificação: o que o vendor não acha fica sem pino e não derruba o resto; respeita o teto por rodada e o prazo", async () => {
    const { run } = await runOnTheRoad();
    const geocoder = new FakeGeocoder();
    geocoder.failNext();
    const first = await geocodeRunStops(sdb, geocoder, { runId: run.runId, sleep: async () => {}, maxStops: 1 });
    expect(first).toMatchObject({ attempted: 1, found: 0, remaining: 1, runOpen: true });
    expect(first.attemptedIds).toHaveLength(1);
    // A rodada seguinte pula o que já foi tentado: só a que faltava.
    const second = await geocodeRunStops(sdb, geocoder, { runId: run.runId, sleep: async () => {}, skipStopIds: first.attemptedIds });
    expect(second).toMatchObject({ attempted: 1, found: 1, remaining: 0 });
    const stops = await stopsOf(run.runId);
    expect(stops.map((s) => s.destLat)).toEqual([null, NAZARE.lat]);

    // Endereço sem cobertura em TODAS as paradas: as rodadas terminam (a lista de pulados cresce), nada de loop.
    const nowhere = new FakeGeocoder();
    nowhere.set("Av. Nazaré", null);
    const { run: hopeless } = await runOnTheRoad2();
    let skip: string[] = [];
    let rounds = 0;
    for (;;) {
      const r = await geocodeRunStops(sdb, nowhere, { runId: hopeless.runId, sleep: async () => {}, skipStopIds: skip, maxStops: 1 });
      rounds += 1;
      skip = [...skip, ...r.attemptedIds];
      if (r.remaining === 0 || r.attempted === 0) break;
      if (rounds > 10) throw new Error("loop");
    }
    expect(rounds).toBe(2);
    // Saída fechada: não consulta nada.
    await cancelDeliveryRun(sdb, { runId: hopeless.runId, userId: FIXED_USER_ID });
    expect(await geocodeRunStops(sdb, nowhere, { runId: hopeless.runId })).toMatchObject({ attempted: 0, remaining: 0, runOpen: false });

    // Prazo do worker já perto: não começa parada nenhuma e devolve o que falta.
    const { run: other } = await (async () => {
      const { variantId, rateId } = await setup();
      const paid = await paidMotoboyOrder(variantId, rateId);
      const c = await courier("Terceiro", "(91) 98222-3333");
      return { run: await createDeliveryRun(sdb, { courierId: c.id, orderIds: [paid.orderId], userId: FIXED_USER_ID, now: AFTERNOON }) };
    })();
    const soon = new Date(AFTERNOON.getTime() + 5_000);
    expect(await geocodeRunStops(sdb, geocoder, { runId: other.runId, deadlineAt: soon, now: () => AFTERNOON, sleep: async () => {} })).toMatchObject({ attempted: 0, found: 0, remaining: 1 });
  });

  it("o painel: lista, detalhe com prova, trilha e link; e a ficha do pedido acha a parada", async () => {
    const { paid, stops, token, run, courier: c } = await runOnTheRoad();
    const t = (s: number) => new Date(AFTERNOON.getTime() + s * 1000);
    await recordRunPosition(sdb, { courierToken: token, lat: -1.45, lng: -48.49, accuracyM: 10, recordedAt: t(1), now: t(1) });
    await recordRunPosition(sdb, { courierToken: token, lat: -1.452, lng: -48.49, accuracyM: 10, recordedAt: t(30), now: t(30) });
    await deliver({ courierToken: token, stopId: stops.find((s) => s.orderId === paid.orderId)!.id, receivedBy: "Maria", position: { lat: -1.452, lng: -48.49, accuracyM: 10 }, now: t(40) });

    const list = await listDeliveryRuns(sdb);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: run.runId, status: "en_route", courierName: c.name, stopsTotal: 2, stopsDelivered: 1, stopsFailed: 0, lastPositionAt: t(30) });

    const detail = (await getDeliveryRun(sdb, run.runId))!;
    expect(detail).toMatchObject({ status: "en_route", courier: { name: c.name, phoneE164: "+5591987654321" }, courierUrl: run.courierUrl });
    expect(detail.lastPosition).toMatchObject({ lat: -1.452, lng: -48.49, recordedAt: t(30) });
    expect(detail.trail.map((p) => p.recordedAt)).toEqual([t(1), t(30)]);
    const delivered = detail.stops.find((s) => s.orderId === paid.orderId)!;
    expect(delivered).toMatchObject({ status: "delivered", receivedBy: "Maria", deliveredPoint: { lat: -1.452, lng: -48.49, accuracyM: 10 } });
    expect(await getDeliveryRun(sdb, "x")).toBeNull();

    // Encerrada, o detalhe ainda lista as paradas.
    await failStop(sdb, { courierToken: token, stopId: stops.find((s) => s.orderId !== paid.orderId)!.id, reason: "outro" });
    await finishDeliveryRun(sdb, { courierToken: token, now: t(100) });
    const closed = (await getDeliveryRun(sdb, run.runId))!;
    expect(closed.status).toBe("finished");
    expect(closed.stops.map((s) => s.status).sort()).toEqual(["delivered", "failed"]);
    expect(closed.stops.find((s) => s.orderId === paid.orderId)?.addressLine).toBe("Av. Nazaré, 100, apto 12 — Nazaré, Belém");
  });

  it("a trilha some depois de 30 dias (pela chegada ao servidor); a última posição de saída fechada há 30 dias também", async () => {
    const { token, run, stops } = await runOnTheRoad();
    const old = new Date("2026-08-01T12:00:00Z");
    await recordRunPosition(sdb, { courierToken: token, lat: -1.45, lng: -48.49, recordedAt: old, now: old });
    await recordRunPosition(sdb, { courierToken: token, lat: -1.451, lng: -48.49, recordedAt: AFTERNOON, now: AFTERNOON });
    expect(await purgeOldDeliveryPositions(sdb, { now: new Date("2026-09-18T20:00:00Z") })).toEqual({ deleted: 1, runsCleared: 0 });
    const trail = await db.select().from(schema.deliveryPositions).where(eq(schema.deliveryPositions.runId, run.runId));
    expect(trail.map((p) => p.recordedAt)).toEqual([AFTERNOON]);
    let [row] = await db.select().from(schema.deliveryRuns).where(eq(schema.deliveryRuns.id, run.runId));
    expect(row.lastLat).not.toBeNull();

    for (const stop of stops) await failStop(sdb, { courierToken: token, stopId: stop.id, reason: "outro" });
    await finishDeliveryRun(sdb, { courierToken: token, now: AFTERNOON });
    expect(await purgeOldDeliveryPositions(sdb, { now: new Date("2026-10-20T20:00:00Z") })).toEqual({ deleted: 1, runsCleared: 1 });
    [row] = await db.select().from(schema.deliveryRuns).where(eq(schema.deliveryRuns.id, run.runId));
    expect(row.lastLat).toBeNull();
    expect(row.lastPositionAt).toEqual(AFTERNOON);
  });

  it("saída esquecida aberta há mais de 24 h fecha sozinha e avisa a dona", async () => {
    const { paid, cash, stops, token, run } = await runOnTheRoad();
    expect(await closeStaleDeliveryRuns(sdb, { now: new Date(AFTERNOON.getTime() + 2 * 3_600_000) })).toEqual({ closed: 0 });
    await deliver({ courierToken: token, stopId: stops.find((s) => s.orderId === paid.orderId)!.id, now: AFTERNOON });
    const later = new Date(AFTERNOON.getTime() + 25 * 3_600_000);
    // Velha mas em uso (posição há 1 h): fica.
    await recordRunPosition(sdb, { courierToken: token, lat: -1.45, lng: -48.49, recordedAt: new Date(later.getTime() - 3_600_000), now: new Date(later.getTime() - 3_600_000) });
    expect(await closeStaleDeliveryRuns(sdb, { now: later })).toEqual({ closed: 0 });
    const muchLater = new Date(later.getTime() + 3 * 3_600_000);
    expect(await closeStaleDeliveryRuns(sdb, { now: muchLater })).toEqual({ closed: 1 });
    const [row] = await db.select().from(schema.deliveryRuns).where(eq(schema.deliveryRuns.id, run.runId));
    expect(row.status).toBe("canceled");
    expect((await stopsOf(run.runId)).find((s) => s.orderId === cash.orderId)?.status).toBe("canceled");
    const alert = (await outboxEvents()).find((e) => e.dedupeKey === `wa.run_stale:${run.runId}`);
    expect((alert?.payload as { body: string }).body).toContain("1 parada por entregar");

    // Sem pendentes, encerra em vez de cancelar.
    const second = await (async () => {
      const { variantId, rateId } = await setup();
      const p = await paidMotoboyOrder(variantId, rateId);
      const c = await courier("Outro", "(91) 98111-2222");
      const r = await createDeliveryRun(sdb, { courierId: c.id, orderIds: [p.orderId], userId: FIXED_USER_ID, now: AFTERNOON });
      await startDeliveryRun(sdb, { courierToken: r.courierToken, now: AFTERNOON });
      const [stop] = await stopsOf(r.runId);
      await deliver({ courierToken: r.courierToken, stopId: stop.id, now: AFTERNOON });
      return r;
    })();
    expect(await closeStaleDeliveryRuns(sdb, { now: muchLater })).toEqual({ closed: 1 });
    const [row2] = await db.select().from(schema.deliveryRuns).where(eq(schema.deliveryRuns.id, second.runId));
    expect(row2.status).toBe("finished");
  });

  it("'cliente pediu outro dia': a peça voltou — dá para reagendar, o pedido volta à Rota do dia e pode sair de novo", async () => {
    const { paid, stops, token } = await runOnTheRoad();
    await failStop(sdb, { courierToken: token, stopId: stops.find((s) => s.orderId === paid.orderId)!.id, reason: "cliente_pediu_outro_dia" });
    // Antes: pedido pago já saiu (shipped + dispatchedAt) — só o "voltou" libera o reagendamento.
    const threeDaysLater = new Date(AFTERNOON.getTime() + 3 * 86_400_000);
    await rescheduleOrderWindow(sdb, { orderId: paid.orderId, userId: FIXED_USER_ID, dayKey: "2026-09-22", window: WINDOWS[0], now: threeDaysLater });
    const row = await orderRow(paid.orderId);
    expect(row.status).toBe("shipped");
    expect(row.deliveryWindow?.dispatchedAt).toBeUndefined();
    expect(row.deliveryWindow?.dayKey).toBe("2026-09-22");
    // Aparece na Rota do dia (sem includeShipped) e é elegível para outra saída, mesmo 3 dias depois.
    expect((await listRouteOfDay(sdb, { now: threeDaysLater })).upcoming.some((day) => day.windows.some((w) => w.orders.some((o) => o.id === paid.orderId)))).toBe(true);
    expect((await listRunEligibleOrders(sdb, { now: threeDaysLater })).some((o) => o.id === paid.orderId)).toBe(true);
    const c2 = await courier("Terceiro", "(91) 98222-3333");
    const again = await createDeliveryRun(sdb, { courierId: c2.id, orderIds: [paid.orderId], userId: FIXED_USER_ID, now: threeDaysLater });
    expect(again.stops[0].alreadyDispatched).toBe(true);
    // Pedido que saiu e NÃO voltou continua sem reagendamento.
    const { cash } = await runOnTheRoad2();
    await expect(rescheduleOrderWindow(sdb, { orderId: cash.orderId, userId: FIXED_USER_ID, dayKey: "2026-09-22", window: WINDOWS[0], now: threeDaysLater })).rejects.toThrow(/já não saiu|ainda não saiu/);
  });

  it("a ficha do pedido prefere a prova de uma saída anterior à parada cancelada", async () => {
    const { paid, stops, token, run } = await runOnTheRoad();
    await failStop(sdb, { courierToken: token, stopId: stops.find((s) => s.orderId === paid.orderId)!.id, reason: "ninguem_em_casa" });
    await cancelDeliveryRun(sdb, { runId: run.runId, userId: FIXED_USER_ID });
    const c2 = await courier("Outro", "(91) 98111-2222");
    const again = await createDeliveryRun(sdb, { courierId: c2.id, orderIds: [paid.orderId], userId: FIXED_USER_ID, now: new Date(AFTERNOON.getTime() + 3_600_000) });
    expect(await getStopForOrder(sdb, paid.orderId)).toMatchObject({ runId: again.runId, stopStatus: "pending" });
    await cancelDeliveryRun(sdb, { runId: again.runId, userId: FIXED_USER_ID });
    expect(await getStopForOrder(sdb, paid.orderId)).toMatchObject({ runId: run.runId, stopStatus: "failed", failureReason: "ninguem_em_casa" });
  });
});
