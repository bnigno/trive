// Geocodificação do endereço de entrega (o pino da parada no mapa e a
// distância "a 2,1 km de você"). Vendor atrás de interface própria: real =
// Nominatim do OpenStreetMap (client.ts, sem chave, 1 pedido por segundo e
// identificação obrigatória), fake = roteirizável (fake.ts). Best-effort por
// contrato: null nunca derruba a saída — a parada fica sem pino.
import { getAdapterMode } from "../adapter-mode";
import { NominatimGeocoder } from "./client";
import { FakeGeocoder } from "./fake";

export interface GeocodeQuery {
  street: string;
  number: string;
  district: string;
  city: string;
  /** UF com 2 letras. */
  state: string;
  /** 8 dígitos (opcional: ajuda a desempatar). */
  postalCode?: string | null;
}

export interface GeoResult {
  lat: number;
  lng: number;
}

export interface Geocoder {
  /** null = não achou ou o vendor falhou (o motivo fica no log, nunca no chamador). */
  geocode(query: GeocodeQuery): Promise<GeoResult | null>;
}

let instance: Geocoder | undefined;

export function getGeocoder(): Geocoder {
  if (!instance) {
    instance = getAdapterMode() === "real" ? new NominatimGeocoder() : new FakeGeocoder();
  }
  return instance;
}
