import type { GeocodeQuery, Geocoder, GeoResult } from "./index";

/**
 * Geocodificador roteirizável: `set(rua, ponto)` cadastra respostas por rua
 * (comparação sem acento e sem caixa); `failNext` responde null uma vez.
 * Sem roteiro, conhece a Av. Nazaré (Belém) e devolve null para o resto.
 */
export class FakeGeocoder implements Geocoder {
  readonly calls: GeocodeQuery[] = [];
  private readonly known = new Map<string, GeoResult>([[normalize("Av. Nazaré"), { lat: -1.4558, lng: -48.4902 }]]);
  private failures = 0;

  set(street: string, point: GeoResult | null): void {
    if (point) this.known.set(normalize(street), point);
    else this.known.delete(normalize(street));
  }

  failNext(): void {
    this.failures += 1;
  }

  async geocode(query: GeocodeQuery): Promise<GeoResult | null> {
    this.calls.push(query);
    if (this.failures > 0) {
      this.failures -= 1;
      return null;
    }
    const found = this.known.get(normalize(query.street));
    return found ? { ...found } : null;
  }

  reset(): void {
    this.calls.length = 0;
    this.failures = 0;
  }
}

function normalize(street: string): string {
  return street
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}
