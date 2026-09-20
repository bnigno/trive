// SuperFrete: POST /api/v0/calculator com token, User-Agent identificado e
// UM pacote (cm/kg); a resposta vira PAC/SEDEX em centavos ou um erro tipado
// que o serviço transforma em "frete pela equipe". Fake roteirizável.
import { afterEach, describe, expect, it, vi } from "vitest";

import { SuperFreteClient, toResult } from "@/adapters/superfrete/client";
import { FakeCorreiosQuoter } from "@/adapters/superfrete/fake";
import { CorreiosQuoteUnavailableError, getCorreiosQuoter, isCorreiosQuotesConfigured } from "@/adapters/superfrete";

type Route = { status: number; body?: unknown; rawBody?: string; throws?: boolean; timeout?: boolean };

function fetchFor(handler: (url: string) => Route) {
  const calls: { url: string; init: { method?: string; headers?: Record<string, string>; body?: string } | undefined }[] = [];
  const fetchFn = async (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => {
    calls.push({ url: input, init });
    const route = handler(input);
    if (route.throws) throw new Error("rede fora");
    if (route.timeout) {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      throw error;
    }
    return new Response(route.rawBody ?? JSON.stringify(route.body ?? []), { status: route.status });
  };
  return { calls, fetchFn };
}

const INPUT = {
  fromCep: "66045335",
  toCep: "01310100",
  weightGrams: 600,
  package: { heightCm: 4, widthCm: 16, lengthCm: 24 },
  services: ["PAC", "SEDEX"] as const,
};

const OK_BODY = [
  { id: 1, name: "PAC", price: 22.9, discount: "3.10", currency: "R$", delivery_time: 8, delivery_range: { min: 6, max: 9 }, has_error: false },
  { id: 2, name: "SEDEX", price: "39.90", currency: "R$", delivery_time: 2, has_error: false },
  { id: 17, name: "Mini Envios", price: 12.5, delivery_time: 10, has_error: false },
];

describe("SuperFreteClient", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("manda token, User-Agent identificado e o pacote em cm/kg; devolve PAC e SEDEX em centavos (Mini Envios fora)", async () => {
    vi.stubEnv("SUPERFRETE_TOKEN", "tok-x");
    vi.stubEnv("SUPERFRETE_BASE_URL", "");
    const { calls, fetchFn } = fetchFor(() => ({ status: 200, body: OK_BODY }));
    const results = await new SuperFreteClient(fetchFn).quote(INPUT);

    expect(results.map((r) => ({ ...r, raw: undefined }))).toEqual([
      { service: "PAC", serviceCode: "1", priceCents: 2290, deliveryDaysMin: 6, deliveryDaysMax: 9, raw: undefined },
      { service: "SEDEX", serviceCode: "2", priceCents: 3990, deliveryDaysMin: 2, deliveryDaysMax: 2, raw: undefined },
    ]);
    expect(results[0].raw).toMatchObject({ id: 1, name: "PAC" });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.superfrete.com/api/v0/calculator");
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.headers?.Authorization).toBe("Bearer tok-x");
    expect(calls[0].init?.headers?.["User-Agent"]).toMatch(/^TRIVE\/1\.0 \(.+@.+\)$/);
    expect(calls[0].init?.headers?.["Content-Type"]).toBe("application/json");
    expect(JSON.parse(calls[0].init?.body ?? "{}")).toEqual({
      from: { postal_code: "66045335" },
      to: { postal_code: "01310100" },
      services: "1,2",
      options: { own_hand: false, receipt: false, insurance_value: 0, use_insurance_value: false },
      package: { height: 4, width: 16, length: 24, weight: 0.6 },
    });
  });

  it("SUPERFRETE_BASE_URL aponta para o sandbox (barra final tolerada); só PAC pedido → services '1'", async () => {
    vi.stubEnv("SUPERFRETE_TOKEN", "tok-x");
    vi.stubEnv("SUPERFRETE_BASE_URL", "https://sandbox.superfrete.com/");
    const { calls, fetchFn } = fetchFor(() => ({ status: 200, body: OK_BODY }));
    const results = await new SuperFreteClient(fetchFn).quote({ ...INPUT, weightGrams: 300, services: ["PAC"] });
    expect(calls[0].url).toBe("https://sandbox.superfrete.com/api/v0/calculator");
    expect(JSON.parse(calls[0].init?.body ?? "{}")).toMatchObject({ services: "1", package: { weight: 0.3 } });
    expect(results.map((r) => r.service)).toEqual(["PAC"]);
  });

  it("sem token não chama a rede (no_token)", async () => {
    vi.stubEnv("SUPERFRETE_TOKEN", "");
    const { calls, fetchFn } = fetchFor(() => ({ status: 200, body: OK_BODY }));
    await expect(new SuperFreteClient(fetchFn).quote(INPUT)).rejects.toMatchObject({ name: "CorreiosQuoteUnavailableError", reason: "no_token" });
    expect(calls).toHaveLength(0);
  });

  it.each([
    [{ status: 401, body: { message: "unauthorized" } }, "http_401"],
    [{ status: 422, body: { errors: { to: ["CEP inválido"] } } }, "http_422"],
    [{ status: 500 }, "http_500"],
    [{ status: 200, throws: true }, "network"],
    [{ status: 200, timeout: true }, "timeout"],
    [{ status: 200, rawBody: "<html>" }, "invalid_response"],
    [{ status: 200, body: { not: "an array" } }, "invalid_response"],
  ] as [Route, string][])("falha %o vira CorreiosQuoteUnavailableError(%s), sem o corpo na mensagem", async (route, reason) => {
    vi.stubEnv("SUPERFRETE_TOKEN", "tok-x");
    const { fetchFn } = fetchFor(() => route);
    const promise = new SuperFreteClient(fetchFn).quote(INPUT);
    await expect(promise).rejects.toBeInstanceOf(CorreiosQuoteUnavailableError);
    await expect(promise).rejects.toMatchObject({ reason });
    await promise.catch((error: Error) => {
      expect(error.message).not.toContain("unauthorized");
      expect(error.message).not.toContain("CEP inválido");
    });
  });

  it("item com erro, preço zero, id desconhecido ou sem prazo é descartado; resposta só com erros = []", async () => {
    vi.stubEnv("SUPERFRETE_TOKEN", "tok-x");
    const body = [
      { id: 1, name: "PAC", price: 22.9, delivery_time: 8, has_error: true, error: "Serviço indisponível para o trecho" },
      { id: 2, name: "SEDEX", price: 0, delivery_time: 2 },
      { id: 4, name: "Jadlog", price: 30, delivery_time: 5 },
      { id: 2, name: "SEDEX", price: 39.9 },
    ];
    const { fetchFn } = fetchFor(() => ({ status: 200, body }));
    expect(await new SuperFreteClient(fetchFn).quote(INPUT)).toEqual([]);
  });

  it("toResult: preço string vira centavos sem float perdido; prazo invertido é reordenado; error vazio não conta", () => {
    expect(toResult({ id: 2, price: "39.90", delivery_range: { min: 3, max: 2 }, error: "" }, ["PAC", "SEDEX"])).toMatchObject({
      service: "SEDEX",
      priceCents: 3990,
      deliveryDaysMin: 2,
      deliveryDaysMax: 3,
    });
    expect(toResult({ id: 1, price: 0.1 + 0.2, delivery_time: 5 }, ["PAC"])?.priceCents).toBe(30);
    expect(toResult({ id: 1, price: 10, delivery_time: 5 }, ["SEDEX"])).toBeNull();
  });

  it("em modo fake está sempre configurado e devolve o fake; em real depende do token", () => {
    vi.stubEnv("ADAPTER_MODE", "fake");
    expect(isCorreiosQuotesConfigured()).toBe(true);
    expect(getCorreiosQuoter()).toBeInstanceOf(FakeCorreiosQuoter);
    vi.stubEnv("ADAPTER_MODE", "real");
    vi.stubEnv("SUPERFRETE_TOKEN", "");
    expect(isCorreiosQuotesConfigured()).toBe(false);
    vi.stubEnv("SUPERFRETE_TOKEN", "  ");
    expect(isCorreiosQuotesConfigured()).toBe(false);
    vi.stubEnv("SUPERFRETE_TOKEN", "tok-x");
    expect(isCorreiosQuotesConfigured()).toBe(true);
  });
});

describe("FakeCorreiosQuoter", () => {
  it("padrão PAC 22,90 (6–9) e SEDEX 39,90 (2–3); filtra pelos serviços pedidos; guarda as chamadas", async () => {
    const fake = new FakeCorreiosQuoter();
    const both = await fake.quote(INPUT);
    expect(both.map((r) => [r.service, r.priceCents, r.deliveryDaysMin, r.deliveryDaysMax])).toEqual([
      ["PAC", 2290, 6, 9],
      ["SEDEX", 3990, 2, 3],
    ]);
    const onlySedex = await fake.quote({ ...INPUT, services: ["SEDEX"] });
    expect(onlySedex.map((r) => r.service)).toEqual(["SEDEX"]);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]).toMatchObject({ fromCep: "66045335", toCep: "01310100", weightGrams: 600 });
  });

  it("set troca o roteiro (cópias, não referências); failNext derruba a próxima chamada com o motivo; reset limpa tudo", async () => {
    const fake = new FakeCorreiosQuoter();
    fake.set([{ service: "PAC", serviceCode: "1", priceCents: 1500, deliveryDaysMin: 4, deliveryDaysMax: 5, raw: null }]);
    const scripted = await fake.quote(INPUT);
    expect(scripted).toHaveLength(1);
    scripted[0].priceCents = 1;
    expect((await fake.quote(INPUT))[0].priceCents).toBe(1500);

    fake.failNext("timeout");
    await expect(fake.quote(INPUT)).rejects.toMatchObject({ reason: "timeout" });
    expect(await fake.quote(INPUT)).toHaveLength(1);

    fake.reset();
    expect(fake.calls).toHaveLength(0);
    expect(await fake.quote(INPUT)).toHaveLength(2);
  });
});
