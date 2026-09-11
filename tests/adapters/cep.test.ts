// Consulta de CEP: BrasilAPI primeiro, ViaCEP no fallback, fake roteirizável.
import { describe, expect, it } from "vitest";

import { CepLookupUnavailableError } from "@/adapters/cep";
import { BrasilApiCepClient } from "@/adapters/cep/client";
import { FakeCepLookup } from "@/adapters/cep/fake";

type Route = { status: number; body?: unknown; throws?: boolean };

function fetchFor(routes: Record<string, Route>) {
  const calls: string[] = [];
  const fetchFn = async (input: string) => {
    calls.push(input);
    const route = Object.entries(routes).find(([prefix]) => input.startsWith(prefix))?.[1];
    if (!route) throw new Error(`rota inesperada: ${input}`);
    if (route.throws) throw new Error("rede fora");
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status });
  };
  return { calls, fetchFn };
}

const BRASIL = "https://brasilapi.com.br/";
const VIA = "https://viacep.com.br/";

describe("BrasilApiCepClient", () => {
  it("BrasilAPI responde: endereço normalizado (UF maiúscula, CEP só dígitos)", async () => {
    const { calls, fetchFn } = fetchFor({
      [BRASIL]: { status: 200, body: { cep: "66045335", state: "pa", city: "Belém", neighborhood: "Cremação", street: "Travessa Três de Maio" } },
    });
    const client = new BrasilApiCepClient(fetchFn);
    expect(await client.lookup("66045-335")).toEqual({
      cep: "66045335",
      street: "Travessa Três de Maio",
      district: "Cremação",
      city: "Belém",
      state: "PA",
    });
    expect(calls).toHaveLength(1);
  });

  it("404 na BrasilAPI é CEP inexistente: null, sem tentar o ViaCEP", async () => {
    const { calls, fetchFn } = fetchFor({ [BRASIL]: { status: 404, body: { message: "not found" } } });
    expect(await new BrasilApiCepClient(fetchFn).lookup("00000000")).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("erro na BrasilAPI cai no ViaCEP; erro:true no ViaCEP é null", async () => {
    const { calls, fetchFn } = fetchFor({
      [BRASIL]: { status: 500 },
      [VIA]: { status: 200, body: { cep: "01310-100", logradouro: "Avenida Paulista", bairro: "Bela Vista", localidade: "São Paulo", uf: "SP" } },
    });
    expect(await new BrasilApiCepClient(fetchFn).lookup("01310100")).toMatchObject({
      street: "Avenida Paulista",
      district: "Bela Vista",
      city: "São Paulo",
      state: "SP",
    });
    expect(calls).toHaveLength(2);

    const missing = fetchFor({ [BRASIL]: { status: 200, throws: true }, [VIA]: { status: 200, body: { erro: true } } });
    expect(await new BrasilApiCepClient(missing.fetchFn).lookup("99999999")).toBeNull();
  });

  it("os dois fora do ar → CepLookupUnavailableError; CEP incompleto → null sem chamar ninguém", async () => {
    const { calls, fetchFn } = fetchFor({ [BRASIL]: { status: 502 }, [VIA]: { status: 200, throws: true } });
    await expect(new BrasilApiCepClient(fetchFn).lookup("01310100")).rejects.toBeInstanceOf(CepLookupUnavailableError);
    expect(calls).toHaveLength(2);
    expect(await new BrasilApiCepClient(fetchFn).lookup("0131")).toBeNull();
    expect(calls).toHaveLength(2);
  });
});

describe("FakeCepLookup", () => {
  it("conhece os CEPs de exemplo, aceita roteiro e simula vendor fora", async () => {
    const fake = new FakeCepLookup();
    expect((await fake.lookup("01310-100"))?.city).toBe("São Paulo");
    expect(await fake.lookup("12345678")).toBeNull();
    fake.set("68795-000", { street: "Rua da Praça", district: "Centro", city: "Benevides", state: "PA" });
    expect(await fake.lookup("68795000")).toEqual({ cep: "68795000", street: "Rua da Praça", district: "Centro", city: "Benevides", state: "PA" });
    fake.failNext();
    await expect(fake.lookup("01310100")).rejects.toBeInstanceOf(CepLookupUnavailableError);
    expect(fake.calls).toEqual(["01310100", "12345678", "68795000", "01310100"]);
  });
});
