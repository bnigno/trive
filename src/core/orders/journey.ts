// Linha do tempo do pedido como a cliente lê na página pública — PURA.
//
// Cinco passos fixos (recebido → pago → embalado → enviado → entregue), cada
// um com o instante em que aconteceu quando o pedido guardou o carimbo. O
// passo "embalado" é o gesto humano da maison: quando o dono tirou a foto do
// pacote, o passo ganha a foto e o nome "Embalado"; quando só iniciou a
// separação, chama-se "Em preparação". Cancelado/reembolsado não tem linha:
// a página mostra o aviso.

import { deliveredStepDetail } from "@/core/orders/delivery";
import type { OrderStatus } from "@/core/orders/state-machine";

export type JourneyStepKey = "received" | "paid" | "packed" | "shipped" | "delivered";
export type JourneyStepState = "done" | "current" | "upcoming";

export interface JourneyStep {
  key: JourneyStepKey;
  label: string;
  at: Date | null;
  state: JourneyStepState;
  /** Uma linha a mais sob o passo (ex.: "Recebido por Maria"). */
  detail?: string | null;
}

export interface OrderJourneyInput {
  status: OrderStatus;
  createdAt: Date;
  paidAt: Date | null;
  packedAt: Date | null;
  /** Primeira entrada em 'preparing' no histórico — vale quando não há foto. */
  preparingAt: Date | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  /** Quem recebeu a entrega (primeiro nome), quando a dona registrou. */
  receivedBy?: string | null;
}

/** Índice do passo "atual" por status; cancelado/reembolsado ficam de fora. */
const CURRENT_INDEX: Partial<Record<OrderStatus, number>> = {
  draft: 0,
  pending_payment: 1,
  paid: 2,
  preparing: 2,
  shipped: 3,
  delivered: 4,
};

export function buildOrderJourney(input: OrderJourneyInput): JourneyStep[] | null {
  const current = CURRENT_INDEX[input.status];
  if (current === undefined) return null;

  const allDone = input.status === "delivered";
  const stateOf = (index: number): JourneyStepState => {
    if (allDone || index < current) return "done";
    if (index === current) return "current";
    return "upcoming";
  };

  const paidState = stateOf(1);
  const packedHappened = input.packedAt !== null;
  // Dinheiro na entrega embala antes de pagar: a foto existe com o pagamento
  // ainda "a seguir" — o passo é feito (ou atual) mesmo assim.
  const packedState: JourneyStepState = packedHappened && stateOf(2) === "upcoming" ? "done" : stateOf(2);
  // 'paid' ainda não começou a separar: o passo é "Separação", a seguir.
  const packedLabel =
    packedState === "upcoming" || (input.status === "paid" && !packedHappened)
      ? "Separação"
      : packedHappened
        ? "Embalado"
        : packedState === "done"
          ? "Separado"
          : "Em preparação";

  return [
    { key: "received", label: "Recebido", at: input.createdAt, state: stateOf(0) },
    {
      key: "paid",
      label: paidState === "done" ? "Pago" : "Pagamento",
      at: input.paidAt,
      state: paidState,
    },
    {
      key: "packed",
      label: packedLabel,
      at: input.packedAt ?? (packedState === "upcoming" ? null : input.preparingAt),
      state: packedState,
    },
    { key: "shipped", label: "Enviado", at: input.shippedAt, state: stateOf(3) },
    {
      key: "delivered",
      label: "Entregue",
      at: input.deliveredAt,
      state: stateOf(4),
      detail: stateOf(4) === "done" ? deliveredStepDetail(input.receivedBy ?? null) : null,
    },
  ];
}
