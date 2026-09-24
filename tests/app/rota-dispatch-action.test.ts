// "Saiu" com o motoboy escolhido: a action lê o courierId ("" = "Outro —
// sem link de GPS") e chama um service só; as mensagens dependem do que ele
// fez. O service é dublê: aqui só a fronteira e as mensagens importam.
import { afterEach, describe, expect, it, vi } from "vitest";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const COURIER_ID = "00000000-0000-4000-8000-0000000000bb";

const calls: unknown[] = [];
let alreadyDispatched = false;

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({ redirect: () => undefined }));
vi.mock("@/services/auth", () => ({ requireUser: async () => ({ id: USER_ID }) }));
vi.mock("@/db/client", () => ({ getDb: () => ({}) }));
vi.mock("@/services/delivery-runs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/delivery-runs")>()),
  dispatchOrderWithCourier: async (_db: unknown, input: { courierId: string | null }) => {
    calls.push(input);
    return { orderNumber: 1008, withCourier: input.courierId !== null, alreadyDispatched };
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
    calls.length = 0;
    alreadyDispatched = false;
  });

  it("com motoboy escolhido: passa o motoboy ao service; a mensagem fala do link com o GPS", async () => {
    const state = await dispatchOrderAction({}, form({ orderId: ORDER_ID, courierId: COURIER_ID }));
    expect(calls).toEqual([{ orderId: ORDER_ID, courierId: COURIER_ID, userId: USER_ID }]);
    expect(state.success).toMatch(/#1008 saiu.*link com o GPS/);
  });

  it("pedido que já tinha saído sem motoboy: a mensagem diz que a cliente não recebe outro aviso", async () => {
    alreadyDispatched = true;
    const state = await dispatchOrderAction({}, form({ orderId: ORDER_ID, courierId: COURIER_ID }));
    expect(state.success).toMatch(/não recebe outro aviso/);
  });

  it("sem motoboy (form antigo) ou 'Outro — sem link de GPS': courierId null, o 'Saiu' de antes", async () => {
    const plain = await dispatchOrderAction({}, form({ orderId: ORDER_ID }));
    await dispatchOrderAction({}, form({ orderId: ORDER_ID, courierId: "" }));
    expect(calls).toEqual([
      { orderId: ORDER_ID, courierId: null, userId: USER_ID },
      { orderId: ORDER_ID, courierId: null, userId: USER_ID },
    ]);
    expect(plain.success).toBe("Pedido #1008 saiu — a cliente recebe o aviso no WhatsApp.");
  });

  it("motoboy inválido: erro em português, nada sai", async () => {
    const state = await dispatchOrderAction({}, form({ orderId: ORDER_ID, courierId: "lixo" }));
    expect(state.error).toBe("Escolha o motoboy.");
    expect(calls).toEqual([]);
  });
});
