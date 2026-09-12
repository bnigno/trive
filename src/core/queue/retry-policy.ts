export type RetryPolicy = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

// Políticas por event_type entram aqui (ex.: 'whatsapp.send': { ... }).
// Sem entrada específica, vale a 'default'.
export const RETRY_POLICIES: Record<string, RetryPolicy> = {
  // Pré-desenho do post da peça (publicação e atualização do cartão): ninguém
  // espera na tela (a dona gera de novo quando quiser), então poucas
  // tentativas e rápidas.
  "product.published": {
    maxAttempts: 2,
    baseDelayMs: 10_000,
    maxDelayMs: 60_000,
  },
  "product.card_refresh": {
    maxAttempts: 2,
    baseDelayMs: 10_000,
    maxDelayMs: 60_000,
  },
  // Cartões da edição ao pagar: a dona refaz na tela se precisar.
  "order.edition_cards": {
    maxAttempts: 2,
    baseDelayMs: 10_000,
    maxDelayMs: 60_000,
  },
  default: {
    maxAttempts: 8,
    baseDelayMs: 5_000,
    maxDelayMs: 3_600_000,
  },
  // Transcrição de áudio da cliente: a resposta da vendedora espera por ela,
  // então poucas tentativas e rápidas; na última, o serviço cai no marcador
  // "não foi possível transcrever" e a conversa segue.
  // Cartão editorial: 2 tentativas (foto que não abre não melhora com tempo).
  "wa.card_render": { maxAttempts: 2, baseDelayMs: 10_000, maxDelayMs: 30_000 },
  "wa.transcribe": {
    maxAttempts: 3,
    baseDelayMs: 5_000,
    maxDelayMs: 20_000,
  },
};

export function getRetryPolicy(eventType: string): RetryPolicy {
  return RETRY_POLICIES[eventType] ?? RETRY_POLICIES["default"];
}

/**
 * Backoff exponencial com jitter: base * 2^(attempt-1), limitado ao teto,
 * multiplicado por um fator em [0.5, 1.5) derivado de `random` (injetável
 * para testes determinísticos; random=0.5 => fator 1.0).
 * `attempt` é 1-based: o número da tentativa que acabou de falhar.
 */
export function nextAttemptDelayMs(
  policy: RetryPolicy,
  attempt: number,
  random: () => number = Math.random,
): number {
  const boundedAttempt = Math.max(1, Math.floor(attempt));
  const exponential = policy.baseDelayMs * 2 ** (boundedAttempt - 1);
  const capped = Math.min(policy.maxDelayMs, exponential);
  const jittered = capped * (0.5 + random());
  return Math.min(policy.maxDelayMs, Math.round(jittered));
}

export function classifyOutcome(
  attempts: number,
  maxAttempts: number,
): "retry" | "dead" {
  return attempts >= maxAttempts ? "dead" : "retry";
}
