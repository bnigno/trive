// Motivos de cancelamento — PURO. O texto técnico que o sistema grava
// (expiração de reserva) e o que a dona digita viram uma frase que a cliente
// pode ler no WhatsApp sem susto.

export const RESERVATION_EXPIRED_REASON =
  "Reserva expirada — pagamento não confirmado no prazo";

export const CANCEL_REASON_MAX_CHARS = 200;

const FALLBACK = "a pedido da loja";

/**
 * "Reserva expirada — …" → "o prazo de pagamento terminou e a reserva foi
 * liberada"; vazio → "a pedido da loja"; texto da dona → limpo (espaços,
 * quebras) e truncado com reticências.
 */
export function friendlyCancelReason(reason: string | null | undefined): string {
  const text = (reason ?? "").replace(/\s+/g, " ").trim();
  if (text === "") return FALLBACK;
  if (text.toLowerCase().startsWith("reserva expirada")) {
    return "o prazo de pagamento terminou e a reserva foi liberada";
  }
  if (text.length <= CANCEL_REASON_MAX_CHARS) return text;
  return `${text.slice(0, CANCEL_REASON_MAX_CHARS - 1).trimEnd()}…`;
}
