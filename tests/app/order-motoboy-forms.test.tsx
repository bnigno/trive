// O "Saiu" que pergunta o motoboy e o "Qual motoboy levou?" da ficha,
// renderizados com react-dom/server: o nome do campo (courierId) é o
// contrato com dispatchOrderAction, e "" é o "Outro — sem link de GPS".
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OrderActions } from "@/app/admin/(protected)/pedidos/[id]/order-actions";
import { CourierForOrderForm, DispatchForm } from "@/app/admin/(protected)/pedidos/rota/forms";

const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const COURIERS = [
  { id: "11111111-1111-4111-8111-111111111111", name: "Carlos Motoboy" },
  { id: "22222222-2222-4222-8222-222222222222", name: "Dani Entregas" },
];

function motoboy(over: Partial<{ dispatchedLabel: string | null; canJoinRun: boolean; previousRun: boolean; couriers: typeof COURIERS }> = {}) {
  return { customerName: "Klícia", dispatchedLabel: null, couriers: COURIERS, canJoinRun: false, previousRun: false, ...over };
}

function actions(status: "paid" | "shipped", m: ReturnType<typeof motoboy>) {
  return renderToStaticMarkup(
    <OrderActions orderId={ORDER_ID} status={status} paymentMethod="pix" mpPaymentId={null} trackingCode={null} canRefund={false} packed motoboy={m} />,
  );
}

describe("DispatchForm", () => {
  it("com motoboy cadastrado: select com o primeiro marcado e a opção 'Outro — sem link de GPS'", () => {
    const html = renderToStaticMarkup(<DispatchForm orderId={ORDER_ID} customerName="Klícia" couriers={COURIERS} />);
    expect(html).toContain('name="courierId"');
    expect(html).toMatch(/<option value="11111111-1111-4111-8111-111111111111" selected="">Carlos Motoboy<\/option>/);
    expect(html).toContain('<option value="">Outro — sem link de GPS</option>');
  });

  it("sem motoboy cadastrado, ou no card da Rota: o 'Saiu' de antes, sem select", () => {
    expect(renderToStaticMarkup(<DispatchForm orderId={ORDER_ID} customerName="Klícia" />)).not.toContain('name="courierId"');
    expect(renderToStaticMarkup(<DispatchForm orderId={ORDER_ID} customerName="Klícia" compact mountRunHint />)).not.toContain('name="courierId"');
  });
});

describe("CourierForOrderForm", () => {
  it("só os motoboys cadastrados (sem 'Outro'), o botão e o texto de quem saiu sem motoboy ou voltou", () => {
    const html = renderToStaticMarkup(<CourierForOrderForm orderId={ORDER_ID} couriers={COURIERS} />);
    expect(html).toContain('name="courierId"');
    expect(html).not.toContain("Outro — sem link de GPS");
    expect(html).toContain("Mandar o link ao motoboy");
    expect(html).toContain("Saiu sem escolher o motoboy");
    expect(renderToStaticMarkup(<CourierForOrderForm orderId={ORDER_ID} couriers={COURIERS} previousRun />)).toContain("A saída anterior fechou sem entregar");
    expect(renderToStaticMarkup(<CourierForOrderForm orderId={ORDER_ID} couriers={[]} />)).toBe("");
  });
});

describe("OrderActions (ficha do pedido de motoboy)", () => {
  it("pago e embalado: o 'Saiu' pergunta o motoboy", () => {
    const html = actions("paid", motoboy());
    expect(html).toContain("Outro — sem link de GPS");
    expect(html).not.toContain("Mandar o link ao motoboy");
  });

  it("saiu sem motoboy e ainda dá para mandar o link: 'Qual motoboy levou?' ao lado do 'Entregue'", () => {
    const html = actions("shipped", motoboy({ dispatchedLabel: "24/09/2026, 09:10", canJoinRun: true }));
    expect(html).toContain("Mandar o link ao motoboy");
    expect(html).toContain("Entregue — o motoboy voltou");
    expect(actions("shipped", motoboy({ dispatchedLabel: "24/09/2026, 09:10", canJoinRun: false }))).not.toContain("Mandar o link ao motoboy");
  });
});
