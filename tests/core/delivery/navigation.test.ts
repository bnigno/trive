// Links de navegação (puro): endereço textual codificado; coordenadas
// quando existem.
import { describe, expect, it } from "vitest";

import { googleMapsDirectionsUrl, wazeUrl } from "@/core/delivery/navigation";

const ADDRESS = "Av. Nazaré, 100, apto 12 — Nazaré, Belém";

describe("links de navegação", () => {
  it("Google Maps: rota de carro até o endereço codificado, ou até as coordenadas", () => {
    expect(googleMapsDirectionsUrl({ address: ADDRESS })).toBe(
      `https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${encodeURIComponent(ADDRESS)}`,
    );
    expect(googleMapsDirectionsUrl({ address: ADDRESS, point: { lat: -1.4558, lng: -48.4902 } })).toContain("destination=-1.455800%2C-48.490200");
  });

  it("Waze: busca pelo endereço, ou navega direto às coordenadas", () => {
    expect(wazeUrl({ address: ADDRESS })).toBe(`https://waze.com/ul?q=${encodeURIComponent(ADDRESS)}&navigate=yes`);
    expect(wazeUrl({ address: ADDRESS, point: { lat: -1.4558, lng: -48.4902 } })).toBe("https://waze.com/ul?ll=-1.455800,-48.490200&navigate=yes");
  });
});
