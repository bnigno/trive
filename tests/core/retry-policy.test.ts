import { describe, expect, it } from "vitest";

import {
  RETRY_POLICIES,
  classifyOutcome,
  getRetryPolicy,
  nextAttemptDelayMs,
  type RetryPolicy,
} from "../../src/core/queue/retry-policy";

const policy: RetryPolicy = {
  maxAttempts: 8,
  baseDelayMs: 5_000,
  maxDelayMs: 3_600_000,
};

const noJitter = () => 0.5;

describe("RETRY_POLICIES", () => {
  it("has a default policy of 8 attempts, base 5s, cap 1h", () => {
    expect(RETRY_POLICIES["default"]).toEqual(policy);
  });

  it("falls back to default for unknown event types", () => {
    expect(getRetryPolicy("unknown.event")).toEqual(RETRY_POLICIES["default"]);
  });

  it("chegada do Ateliê: poucas tentativas e curtas (a dona espera no WhatsApp)", () => {
    expect(getRetryPolicy("wa.atelier_intake")).toEqual({ maxAttempts: 3, baseDelayMs: 10_000, maxDelayMs: 60_000 });
    expect(getRetryPolicy("wa.atelier_card")).toEqual({ maxAttempts: 2, baseDelayMs: 10_000, maxDelayMs: 30_000 });
  });
});

describe("nextAttemptDelayMs", () => {
  it("entrevista da curadora: a pergunta sai no mesmo dia; rascunho e decisão, poucas tentativas curtas", () => {
    expect(getRetryPolicy("curator.interview_ask")).toEqual({ maxAttempts: 4, baseDelayMs: 30_000, maxDelayMs: 600_000 });
    expect(getRetryPolicy("curator.interview_draft")).toEqual({ maxAttempts: 3, baseDelayMs: 10_000, maxDelayMs: 60_000 });
    expect(getRetryPolicy("curator.interview_decide")).toEqual({ maxAttempts: 4, baseDelayMs: 10_000, maxDelayMs: 120_000 });
  });

  it("retorno combinado: 3 tentativas espaçadas (o modelo pode estar fora do ar um instante)", () => {
    expect(getRetryPolicy("wa.bot_followup")).toEqual({ maxAttempts: 3, baseDelayMs: 60_000, maxDelayMs: 600_000 });
    expect(getRetryPolicy("store.revalidate")).toEqual({ maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 });
  });

  it("doubles per attempt when random=0.5 (jitter factor 1.0)", () => {
    expect(nextAttemptDelayMs(policy, 1, noJitter)).toBe(5_000);
    expect(nextAttemptDelayMs(policy, 2, noJitter)).toBe(10_000);
    expect(nextAttemptDelayMs(policy, 3, noJitter)).toBe(20_000);
    expect(nextAttemptDelayMs(policy, 4, noJitter)).toBe(40_000);
  });

  it("applies jitter in [0.5x, 1.5x)", () => {
    expect(nextAttemptDelayMs(policy, 1, () => 0)).toBe(2_500);
    expect(nextAttemptDelayMs(policy, 1, () => 0.999999)).toBe(7_500);
  });

  it("caps at maxDelayMs even with maximum jitter", () => {
    expect(nextAttemptDelayMs(policy, 30, noJitter)).toBe(3_600_000);
    expect(nextAttemptDelayMs(policy, 30, () => 0.999999)).toBe(3_600_000);
  });

  it("reaches the cap at the expected attempt (base*2^(n-1) >= cap)", () => {
    // 5s * 2^10 = 5120s > 3600s
    expect(nextAttemptDelayMs(policy, 11, noJitter)).toBe(3_600_000);
    expect(nextAttemptDelayMs(policy, 10, noJitter)).toBe(2_560_000);
  });

  it("treats attempt <= 1 as the first attempt", () => {
    expect(nextAttemptDelayMs(policy, 0, noJitter)).toBe(5_000);
    expect(nextAttemptDelayMs(policy, -3, noJitter)).toBe(5_000);
  });

  it("never overflows for absurd attempt numbers", () => {
    expect(nextAttemptDelayMs(policy, 1_000, noJitter)).toBe(3_600_000);
  });
});

describe("classifyOutcome", () => {
  it("retries strictly below maxAttempts", () => {
    expect(classifyOutcome(1, 8)).toBe("retry");
    expect(classifyOutcome(7, 8)).toBe("retry");
  });

  it("is dead exactly at maxAttempts", () => {
    expect(classifyOutcome(8, 8)).toBe("dead");
  });

  it("is dead above maxAttempts", () => {
    expect(classifyOutcome(9, 8)).toBe("dead");
  });
});

describe("wa.transcribe", () => {
  it("tenta 3 vezes com espera curta: a cliente está esperando a resposta", () => {
    expect(getRetryPolicy("wa.transcribe")).toEqual({
      maxAttempts: 3,
      baseDelayMs: 5_000,
      maxDelayMs: 20_000,
    });
  });
});

describe("wa.card_render", () => {
  it("tenta 2 vezes: foto que não abre não melhora com o tempo", () => {
    expect(getRetryPolicy("wa.card_render")).toEqual({
      maxAttempts: 2,
      baseDelayMs: 10_000,
      maxDelayMs: 30_000,
    });
  });
});

describe("política do pré-desenho do post", () => {
  it("product.published e product.card_refresh tentam poucas vezes e rápido (ninguém espera na tela)", () => {
    for (const eventType of ["product.published", "product.card_refresh"]) {
      const policy = getRetryPolicy(eventType);
      expect(policy.maxAttempts).toBe(2);
      expect(policy.baseDelayMs).toBeLessThanOrEqual(10_000);
      expect(policy.maxDelayMs).toBeLessThanOrEqual(60_000);
    }
    // O padrão continua paciente para o resto da fila.
    expect(getRetryPolicy("qualquer.outro").maxAttempts).toBeGreaterThan(2);
  });
});
