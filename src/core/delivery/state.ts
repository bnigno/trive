// A saída do motoboy e as paradas — PURO. A saída nasce pronta (link
// enviado), vira "na rua" quando o motoboy toca "Comecei", e fecha quando
// ele encerra (ou a dona cancela). O pedido em si continua passando pela
// máquina de estados de core/orders: aqui é só o ciclo da saída e da prova.

export const RUN_STATUSES = ["ready", "en_route", "finished", "canceled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const STOP_STATUSES = ["pending", "delivered", "failed", "canceled"] as const;
export type StopStatus = (typeof STOP_STATUSES)[number];

const RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  ready: ["en_route", "canceled"],
  en_route: ["finished", "canceled"],
  finished: [],
  canceled: [],
};

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  ready: "Pronta para sair",
  en_route: "Na rua",
  finished: "Encerrada",
  canceled: "Cancelada",
};

export const STOP_STATUS_LABELS: Record<StopStatus, string> = {
  pending: "A entregar",
  delivered: "Entregue",
  failed: "Não entregue",
  canceled: "Cancelada",
};

export class InvalidRunTransitionError extends Error {
  constructor(
    readonly from: RunStatus,
    readonly to: RunStatus,
  ) {
    super(`A saída não pode ir de "${RUN_STATUS_LABELS[from]}" para "${RUN_STATUS_LABELS[to]}".`);
    this.name = "InvalidRunTransitionError";
  }
}

export function canRunTransition(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!canRunTransition(from, to)) throw new InvalidRunTransitionError(from, to);
}

/** A saída ainda aceita posição e entregas. */
export function isRunOpen(status: RunStatus): boolean {
  return status === "ready" || status === "en_route";
}

/** Só uma parada por entregar pode ser fechada, e só com a saída na rua. */
export function canCloseStop(run: RunStatus, stop: StopStatus): boolean {
  return run === "en_route" && stop === "pending";
}

/** O motoboy só encerra quando não sobra parada por entregar. */
export function runCanFinish(stops: readonly { status: StopStatus }[]): boolean {
  return stops.every((stop) => stop.status !== "pending");
}

export const FAILURE_REASONS = ["ninguem_em_casa", "endereco_nao_encontrado", "cliente_pediu_outro_dia", "outro"] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

export const FAILURE_REASON_LABELS: Record<FailureReason, string> = {
  ninguem_em_casa: "Ninguém em casa",
  endereco_nao_encontrado: "Endereço não encontrado",
  cliente_pediu_outro_dia: "Cliente pediu outro dia",
  outro: "Outro motivo",
};

export const FAILURE_NOTE_MAX_CHARS = 200;
export const RUN_MAX_STOPS = 30;
