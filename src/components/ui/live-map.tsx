"use client";

// O mapa sem SSR (o Leaflet precisa de `window`): enquanto carrega, a
// moldura marfim segura o lugar para a página não pular. `className` dá o
// tamanho da moldura; o mapa preenche.
import dynamic from "next/dynamic";

import type { LeafletMapProps } from "./leaflet-map";

const LeafletMap = dynamic(() => import("./leaflet-map").then((m) => m.LeafletMap), {
  ssr: false,
  loading: () => <div className="h-full w-full animate-pulse bg-ivory-200" aria-hidden="true" />,
});

export function LiveMap({ className, ...props }: LeafletMapProps) {
  return (
    <div className={className}>
      <LeafletMap {...props} className="h-full w-full" />
    </div>
  );
}
