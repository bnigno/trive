export type RetryPolicy = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

// Políticas por event_type entram aqui (ex.: 'whatsapp.send': { ... }).
// Sem entrada específica, vale a 'default'.
export const RETRY_POLICIES: Record<string, RetryPolicy> = {
  default: {
    maxAttempts: 8,
    baseDelayMs: 5_000,
    maxDelayMs: 3_600_000,
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
