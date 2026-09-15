import { z } from "zod";

import type { GeocodeQuery, Geocoder, GeoResult } from "./index";

const TIMEOUT_MS = 5_000;
/** Política de uso do Nominatim: identificação com contato e ≤ 1 pedido/s. */
const USER_AGENT = "TRIVE/1.0 (contato@trivemaison.com.br)";

const resultSchema = z.array(
  z.looseObject({
    lat: z.string(),
    lon: z.string(),
  }),
);

type FetchLike = (input: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Response>;
type SleepLike = (ms: number) => Promise<void>;
/** Entre a busca com número e a busca só pela rua: a política pede ≤ 1 pedido/s. */
const RETRY_SPACING_MS = 1_100;

/**
 * Consulta estruturada (rua+número, bairro, cidade, UF, CEP, só Brasil).
 * Primeiro com número; sem resultado, tenta só a rua — o centro da rua
 * ainda serve para uma distância aproximada. Qualquer erro → null.
 */
export class NominatimGeocoder implements Geocoder {
  constructor(
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    private readonly sleep: SleepLike = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async geocode(query: GeocodeQuery): Promise<GeoResult | null> {
    const withNumber = await this.search(query, true);
    if (withNumber) return withNumber;
    if (!query.number.trim()) return null;
    await this.sleep(RETRY_SPACING_MS);
    return this.search(query, false);
  }

  private async search(query: GeocodeQuery, includeNumber: boolean): Promise<GeoResult | null> {
    if (!query.street.trim() || !query.city.trim()) return null;
    const street = [query.street.trim(), includeNumber ? query.number.trim() : ""].filter(Boolean).join(" ");
    const params = new URLSearchParams({
      format: "jsonv2",
      limit: "1",
      countrycodes: "br",
      street,
      city: query.city.trim(),
      state: query.state.trim(),
    });
    if (query.district.trim()) params.set("county", query.district.trim());
    const cep = query.postalCode?.replace(/\D/g, "") ?? "";
    if (cep.length === 8) params.set("postalcode", `${cep.slice(0, 5)}-${cep.slice(5)}`);
    try {
      const response = await this.fetchImpl(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      });
      if (!response.ok) return null;
      const parsed = resultSchema.safeParse(await response.json());
      if (!parsed.success || parsed.data.length === 0) return null;
      const lat = Number(parsed.data[0].lat);
      const lng = Number(parsed.data[0].lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return { lat, lng };
    } catch {
      return null;
    }
  }
}
