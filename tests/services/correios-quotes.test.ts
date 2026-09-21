import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeCorreiosQuoter } from "@/adapters/superfrete/fake";
import { CORREIOS_SERVICES, DEFAULT_PACKAGE_CM, quoteRequestKey } from "@/core/shipping/correios-package";
import * as schema from "@/db/schema";
import {
  describeCorreiosProbeFailure,
  probeCorreiosQuote,
  type CorreiosProbeFailureReason,
} from "@/services/correios-quotes";
import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  await close();
});

// ---------------------------------------------------------------------------
// probeCorreiosQuote: o "Testar cotação" de /admin/frete. A cotação de
// verdade (com cache e gravação) é coberta em store-catalog.test.ts.
// ---------------------------------------------------------------------------

describe("probeCorreiosQuote (Testar cotação em /admin/frete)", () => {
  /** Já normalizado (8 dígitos): o contrato do service. */
  const SP = "01310100";
  let fake: FakeCorreiosQuoter;

  async function setCorreiosSettings(opts: { enabled?: boolean; storeCep?: string; surchargeCents?: number } = {}): Promise<void> {
    await db.insert(schema.settings).values([
      { key: "correios_auto_enabled", value: opts.enabled ?? true },
      { key: "store_cep", value: opts.storeCep ?? "66045-335" },
      { key: "correios_surcharge_cents", value: opts.surchargeCents ?? 300 },
    ]);
  }

  beforeEach(() => {
    fake = new FakeCorreiosQuoter();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("chama o provedor com o CEP de origem salvo, o peso cobrado mínimo e devolve preço do provedor + acréscimo", async () => {
    await setCorreiosSettings();
    const result = await probeCorreiosQuote(db, fake, { cep: SP, weightGrams: 100 });

    expect(fake.calls).toEqual([
      { fromCep: "66045335", toCep: SP, weightGrams: 300, package: DEFAULT_PACKAGE_CM, services: ["PAC", "SEDEX"] },
    ]);
    expect(result).toEqual({
      ok: true,
      storeCep: "66045335",
      weightGrams: 300,
      surchargeCents: 300,
      quotes: [
        { service: "PAC", providerPriceCents: 2290, priceCents: 2590, deliveryDaysMin: 6, deliveryDaysMax: 9 },
        { service: "SEDEX", providerPriceCents: 3990, priceCents: 4290, deliveryDaysMin: 2, deliveryDaysMax: 3 },
      ],
    });
  });

  it("não grava nada em shipping_quotes (é só um teste)", async () => {
    await setCorreiosSettings();
    await probeCorreiosQuote(db, fake, { cep: SP, weightGrams: 600 });
    expect(await db.$count(schema.shippingQuotes)).toBe(0);
  });

  it("com o toggle desligado ainda cota — a dona testa antes de ligar", async () => {
    await setCorreiosSettings({ enabled: false });
    const result = await probeCorreiosQuote(db, fake, { cep: SP, weightGrams: 600 });
    expect(result.ok).toBe(true);
    expect(fake.calls).toHaveLength(1);
  });

  it("sem CEP de origem (setting ausente ou vazia) → no_store_cep, sem chamar o provedor", async () => {
    expect(await probeCorreiosQuote(db, fake, { cep: SP, weightGrams: 600 })).toEqual({ ok: false, reason: "no_store_cep" });

    await setCorreiosSettings({ storeCep: "" });
    expect(await probeCorreiosQuote(db, fake, { cep: SP, weightGrams: 600 })).toEqual({ ok: false, reason: "no_store_cep" });
    expect(fake.calls).toHaveLength(0);
  });

  it("CEP de origem gravado sem hífen volta do jsonb como número e ainda assim serve", async () => {
    await setCorreiosSettings({ storeCep: "66045335" });
    const rows = await db.select().from(schema.settings).where(eq(schema.settings.key, "store_cep"));
    expect(typeof rows[0].value).toBe("number");

    const result = await probeCorreiosQuote(db, fake, { cep: SP, weightGrams: 600 });
    expect(result.ok).toBe(true);
    expect(fake.calls[0].fromCep).toBe("66045335");
  });

  it("falha do provedor vira o motivo, sem esconder (http_401, timeout)", async () => {
    await setCorreiosSettings();
    fake.failNext("http_401");
    expect(await probeCorreiosQuote(db, fake, { cep: SP, weightGrams: 600 })).toEqual({ ok: false, reason: "http_401" });
    fake.failNext("timeout");
    expect(await probeCorreiosQuote(db, fake, { cep: SP, weightGrams: 600 })).toEqual({ ok: false, reason: "timeout" });
    expect(await db.$count(schema.shippingQuotes)).toBe(0);
  });

  it("provedor sem PAC nem SEDEX para o trecho → no_service", async () => {
    await setCorreiosSettings();
    fake.set([]);
    expect(await probeCorreiosQuote(db, fake, { cep: SP, weightGrams: 600 })).toEqual({ ok: false, reason: "no_service" });
  });

  it("erro que não é do provedor sobe (não vira motivo)", async () => {
    await setCorreiosSettings();
    const broken = { quote: async () => { throw new TypeError("boom"); } };
    await expect(probeCorreiosQuote(db, broken, { cep: SP, weightGrams: 600 })).rejects.toThrow("boom");
  });

  it("ignora o cache: uma cotação válida gravada não é lida nem substituída", async () => {
    await setCorreiosSettings();
    const now = new Date();
    const requestKey = quoteRequestKey({
      cepFrom: "66045335",
      cepTo: SP,
      billableWeightGrams: 600,
      package: DEFAULT_PACKAGE_CM,
      surchargeCents: 300,
      services: CORREIOS_SERVICES,
    });
    await db.insert(schema.shippingQuotes).values({
      provider: "superfrete",
      requestKey,
      batchId: "00000000-0000-4000-8000-000000000099",
      serviceCode: "1",
      name: "PAC",
      cepFrom: "66045335",
      cepTo: SP,
      weightGrams: 600,
      package: { ...DEFAULT_PACKAGE_CM },
      providerPriceCents: 99999,
      surchargeCents: 300,
      priceCents: 100299,
      deliveryDaysMin: 1,
      deliveryDaysMax: 1,
      raw: null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    });

    const result = await probeCorreiosQuote(db, fake, { cep: SP, weightGrams: 600 });
    expect(result.ok && result.quotes[0].priceCents).toBe(2590);
    expect(fake.calls).toHaveLength(1);
    expect(await db.$count(schema.shippingQuotes)).toBe(1);
  });

  it("modo real sem SUPERFRETE_TOKEN → no_token, sem chamar o provedor", async () => {
    await setCorreiosSettings();
    vi.stubEnv("ADAPTER_MODE", "real");
    vi.stubEnv("SUPERFRETE_TOKEN", "");
    expect(await probeCorreiosQuote(db, fake, { cep: SP, weightGrams: 600 })).toEqual({ ok: false, reason: "no_token" });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("describeCorreiosProbeFailure", () => {
  it.each<[CorreiosProbeFailureReason, string]>([
    ["no_store_cep", "CEP de origem"],
    ["no_token", "SUPERFRETE_TOKEN"],
    ["timeout", "não respondeu"],
    ["network", "Sem conexão"],
    ["invalid_response", "formato"],
    ["no_service", "PAC nem SEDEX"],
    ["http_401", "recusou o token"],
    ["http_403", "recusou o token"],
    ["http_400", "CEP de destino"],
    ["http_422", "CEP de destino"],
    ["http_429", "Aguarde"],
    ["http_503", "HTTP 503"],
  ])("%s → mensagem em português com a pista certa", (reason, expected) => {
    expect(describeCorreiosProbeFailure(reason)).toContain(expected);
  });
});
