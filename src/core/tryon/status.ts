// "Me vê com ela" — a prévia na foto da cliente. PURO: os estados de um
// pedido de prévia e as transições permitidas. Toda mudança de estado passa
// por aqui (regra 3 do CLAUDE.md).
//
// offered → a Lia ofereceu (a cliente ainda não respondeu);
// declined → tocou "Agora não";
// awaiting_photo → tocou "Quero me ver" e a foto ainda não chegou;
// queued → foto escolhida, na fila (checagem da foto e envio à FASHN);
// submitting → vai pedir à FASHN (gravado ANTES do pedido: é o que impede pagar duas vezes);
// processing → a FASHN aceitou (o id do pedido está gravado);
// sent → a prévia chegou à cliente;
// photo_rejected → a foto não serve (enquadramento, mais de uma pessoa…): nada foi cobrado;
// failed → desistiu (o motivo fica em failure_reason).
//
// Reabrir (photo_rejected/failed → awaiting_photo): a MESMA prévia, com o
// mesmo toque, esperando uma foto NOVA — só quando o problema era da foto
// (enquadramento, não abriu) e ela não disse "Agora não" (services decide).

export const TRYON_STATUSES = [
  "offered",
  "declined",
  "awaiting_photo",
  "queued",
  "submitting",
  "processing",
  "sent",
  "photo_rejected",
  "failed",
] as const;
export type TryOnStatus = (typeof TRYON_STATUSES)[number];

/**
 * submitting → queued: a FASHN recusou por excesso de chamadas (429) — nada foi cobrado.
 * processing → queued: a prévia saiu infiel e ainda cabe outra tentativa (o pedido anterior já foi pago e usado).
 * declined → awaiting_photo: ela mudou de ideia e tocou "Quero me ver" na mesma lista (o toque grava o consentimento de novo).
 * queued → failed: também quando ela desiste ("Agora não", SAIR) antes de a foto ir à FASHN.
 * photo_rejected | failed → awaiting_photo: reabrir com uma foto nova (ver acima).
 */
export const TRYON_TRANSITIONS: Record<TryOnStatus, readonly TryOnStatus[]> = {
  offered: ["declined", "awaiting_photo", "queued"],
  declined: ["awaiting_photo"],
  awaiting_photo: ["queued", "declined"],
  queued: ["submitting", "photo_rejected", "failed"],
  submitting: ["processing", "queued", "failed"],
  processing: ["sent", "queued", "failed"],
  sent: [],
  photo_rejected: ["awaiting_photo"],
  failed: ["awaiting_photo"],
};

/** Na fila ou com a FASHN: ainda pode gastar e ainda vai mudar sozinho. */
export const TRYON_IN_FLIGHT_STATUSES = ["queued", "submitting", "processing"] as const satisfies readonly TryOnStatus[];

export class InvalidTryOnTransitionError extends Error {
  constructor(from: TryOnStatus, to: TryOnStatus) {
    super(`Transição da prévia inválida: "${from}" não pode mudar para "${to}".`);
    this.name = "InvalidTryOnTransitionError";
  }
}

export function isTryOnStatus(value: string): value is TryOnStatus {
  return (TRYON_STATUSES as readonly string[]).includes(value);
}

export function canTransitionTryOn(from: TryOnStatus, to: TryOnStatus): boolean {
  return TRYON_TRANSITIONS[from].includes(to);
}

export function assertTryOnTransition(from: TryOnStatus, to: TryOnStatus): void {
  if (!canTransitionTryOn(from, to)) throw new InvalidTryOnTransitionError(from, to);
}

export function isTryOnInFlight(status: string): boolean {
  return (TRYON_IN_FLIGHT_STATUSES as readonly string[]).includes(status);
}

/** Encerrado: nada mais acontece SOZINHO com este pedido (reabrir é decisão dela, com foto nova). */
export function isTryOnClosed(status: string): boolean {
  return status === "sent" || status === "photo_rejected" || status === "failed";
}
