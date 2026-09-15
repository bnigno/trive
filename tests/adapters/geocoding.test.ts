// Geocodificação: Nominatim com consulta estruturada e identificação, null
// em qualquer falha; fake roteirizável.
import { describe, expect, it } from "vitest";

import { NominatimGeocoder } from "@/adapters/geocoding/client";
import { FakeGeocoder } from "@/adapters/geocoding/fake";

type Route = { status: number; body?: unknown; throws?: boolean };

function fetchFor(handler: (url: string) => Route) {
  const calls: { url: string; headers: Record<string, string> | undefined }[] = [];
  const fetchFn = async (input: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url: input, headers: init?.headers });
    const route = handler(input);
    if (route.throws) throw new Error("rede fora");
    return new Response(JSON.stringify(route.body ?? []), { status: route.status });
  };
  return { calls, fetchFn };
}

const QUERY = { street: "Av. Nazaré", number: "100", district: "Nazaré", city: "Belém", state: "PA", postalCode: "66035170" };

describe("NominatimGeocoder", () => {
  it("consulta estruturada (rua+número, bairro, cidade, UF, CEP, só BR) com User-Agent identificado", async () => {
    const { calls, fetchFn } = fetchFor(() => ({ status: 200, body: [{ lat: "-1.4558", lon: "-48.4902", display_name: "x" }] }));
    const client = new NominatimGeocoder(fetchFn);
    expect(await client.geocode(QUERY)).toEqual({ lat: -1.4558, lng: -48.4902 });
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe("https://nominatim.openstreetmap.org/search");
    expect(url.searchParams.get("street")).toBe("Av. Nazaré 100");
    expect(url.searchParams.get("city")).toBe("Belém");
    expect(url.searchParams.get("state")).toBe("PA");
    expect(url.searchParams.get("county")).toBe("Nazaré");
    expect(url.searchParams.get("postalcode")).toBe("66035-170");
    expect(url.searchParams.get("countrycodes")).toBe("br");
    expect(url.searchParams.get("limit")).toBe("1");
    expect(calls[0].headers?.["User-Agent"]).toMatch(/^TRIVE\/1\.0 \(.+\)$/);
  });

  it("sem resultado com número, tenta só a rua; sem nada, null", async () => {
    const { calls, fetchFn } = fetchFor((url) => ({ status: 200, body: url.includes("100") ? [] : [{ lat: "-1.45", lon: "-48.49" }] }));
    expect(await new NominatimGeocoder(fetchFn).geocode(QUERY)).toEqual({ lat: -1.45, lng: -48.49 });
    expect(calls).toHaveLength(2);
    expect(new URL(calls[1].url).searchParams.get("street")).toBe("Av. Nazaré");

    const empty = fetchFor(() => ({ status: 200, body: [] }));
    expect(await new NominatimGeocoder(empty.fetchFn).geocode(QUERY)).toBeNull();
  });

  it("erro de rede, 5xx, corpo torto ou coordenada inválida → null, nunca lança", async () => {
    expect(await new NominatimGeocoder(fetchFor(() => ({ status: 200, throws: true })).fetchFn).geocode(QUERY)).toBeNull();
    expect(await new NominatimGeocoder(fetchFor(() => ({ status: 503 })).fetchFn).geocode(QUERY)).toBeNull();
    expect(await new NominatimGeocoder(fetchFor(() => ({ status: 200, body: { nope: true } })).fetchFn).geocode(QUERY)).toBeNull();
    expect(await new NominatimGeocoder(fetchFor(() => ({ status: 200, body: [{ lat: "abc", lon: "1" }] })).fetchFn).geocode(QUERY)).toBeNull();
  });

  it("sem rua ou sem cidade não consulta", async () => {
    const { calls, fetchFn } = fetchFor(() => ({ status: 200, body: [] }));
    expect(await new NominatimGeocoder(fetchFn).geocode({ ...QUERY, street: " " })).toBeNull();
    expect(await new NominatimGeocoder(fetchFn).geocode({ ...QUERY, city: "" })).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("FakeGeocoder", () => {
  it("conhece a Av. Nazaré, aceita roteiro por rua (sem acento/caixa) e falha uma vez com failNext", async () => {
    const fake = new FakeGeocoder();
    expect(await fake.geocode(QUERY)).toEqual({ lat: -1.4558, lng: -48.4902 });
    expect(await fake.geocode({ ...QUERY, street: "Rua Inexistente" })).toBeNull();
    fake.set("Travessa Três de Maio", { lat: -1.46, lng: -48.48 });
    expect(await fake.geocode({ ...QUERY, street: "travessa tres de maio" })).toEqual({ lat: -1.46, lng: -48.48 });
    fake.failNext();
    expect(await fake.geocode(QUERY)).toBeNull();
    expect(await fake.geocode(QUERY)).not.toBeNull();
    expect(fake.calls).toHaveLength(5);
    fake.reset();
    expect(fake.calls).toHaveLength(0);
  });
});
