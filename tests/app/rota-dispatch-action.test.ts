// "Saiu" com o motoboy escolhido: a action vira uma saída com GPS de um
// pedido só; sem motoboy (ou "Outro"), é o "Saiu" de antes. Os services são
// dublês: aqui só a escolha da action e as mensagens importam.
import { afterEach, describe, expect, it, vi } from "vitest";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const COURIER_ID = "00000000-0000-4000-8000-0000000000bb";

const dispatched: unknown[] = [];
const runs: unknown[] = [];
let alreadyDispatched = false;

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({ redirect: () => undefined }));
vi.mock("@/services/auth", () => ({ requireUser: async () => ({ id: USER_ID }) }));
vi.mock("@/db/client", () => ({ getDb: () => ({}) }));
vi.mock("@/services/delivery-routes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/delivery-routes")>()),
  dispatchOrder: async (_db: unknown, input: unknown) => {
    dispatched.push(input);
    return { orderId: ORDER_ID, orderNumber: 1008, from: "paid", to: "shipped", idempotent: false };
  },
}));
vi.mock("@/services/delivery-runs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/delivery-runs")>()),
  createDeliveryRun: async (_db: unknown, input: unknown) => {
    runs.push(input);
    return { runId: "run-1", courierToken: "t", courierUrl: "u", stops: [{ orderId: ORDER_ID, orderNumber: 1008, sequence: 1, alreadyDispatched }] };
  },
}));
const { dispatchOrderAction } = await import("@/app/admin/(protected)/pedidos/rota/actions");

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

describe("dispatchOrderAction", () => {
  afterEach(() => {
    dispatched.length = 0;
    runs.length = 0;
    alreadyDispatched = false;
  });

  it("com motoboy escolhido: monta a saída com GPS de um pedido só, sem o 'Saiu' avulso", async () => {
    const state = await dispatchOrderAction({}, form({ orderId: ORDER_ID, courierId: COURIER_ID }));
    expect(runs).toEqual([{ courierId: COURIER_ID, orderIds: [ORDER_ID], userId: USER_ID }]);
    expect(dispatched).toEqual([]);
    expect(state.success).toMatch(/#1008 saiu.*link com o GPS/);
  });

  it("pedido que já tinha saído sem motoboy: o motoboy recebe o link e a mensagem diz que a cliente não recebe outro aviso", async () => {
    alreadyDispatched = true;
    const state = await dispatchOrderAction({}, form({ orderId: ORDER_ID, courierId: COURIER_ID }));
    expect(runs).toHaveLength(1);
    expect(state.success).toMatch(/não recebe outro aviso/);
  });

  it("sem motoboy (form antigo) ou 'Outro — sem link de GPS': só o 'Saiu', como antes", async () => {
    await dispatchOrderAction({}, form({ orderId: ORDER_ID }));
    await dispatchOrderAction({}, form({ orderId: ORDER_ID, courierId: "" }));
    expect(dispatched).toEqual([
      { orderId: ORDER_ID, userId: USER_ID },
      { orderId: ORDER_ID, userId: USER_ID },
    ]);
    expect(runs).toEqual([]);
  });

  it("motoboy inválido: erro em português, nada sai", async () => {
    const state = await dispatchOrderAction({}, form({ orderId: ORDER_ID, courierId: "lixo" }));
    expect(state.error).toBe("Escolha o motoboy.");
    expect(dispatched).toEqual([]);
    expect(runs).toEqual([]);
  });
});
