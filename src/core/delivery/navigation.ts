// Links de navegação para o motoboy — PURO. Por endereço textual (o que o
// pedido gravou), com coordenadas quando a geocodificação chegou: o Waze e
// o Google Maps aceitam os dois; com coordenadas o pino cai no lugar certo.
import type { GeoPoint } from "./positions";

export interface NavigationTarget {
  address: string;
  point?: GeoPoint | null;
}

function coordinates(point: GeoPoint): string {
  return `${point.lat.toFixed(6)},${point.lng.toFixed(6)}`;
}

/** Abre o app do Google Maps (ou o site) já com a rota até o destino. */
export function googleMapsDirectionsUrl(target: NavigationTarget): string {
  const destination = target.point ? coordinates(target.point) : target.address;
  return `https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${encodeURIComponent(destination)}`;
}

/** Deep link universal do Waze: com coordenadas navega direto; sem, busca o endereço. */
export function wazeUrl(target: NavigationTarget): string {
  if (target.point) return `https://waze.com/ul?ll=${coordinates(target.point)}&navigate=yes`;
  return `https://waze.com/ul?q=${encodeURIComponent(target.address)}&navigate=yes`;
}
