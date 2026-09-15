"use client";

// Mapa com Leaflet + OpenStreetMap, sem react-leaflet: um mapa por
// instância, criado uma vez e atualizado por props (o marcador do motoboy,
// os pinos das paradas e a trilha). Carregue por `LiveMap` (dynamic, sem
// SSR): o Leaflet mexe em `window` ao importar.
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef, useState } from "react";

export interface MapPoint {
  lat: number;
  lng: number;
}

export interface MapPin extends MapPoint {
  label: string;
  /** done = entregue, failed = não entregue, pending = por entregar, muted = cancelada. */
  tone: "pending" | "done" | "failed" | "muted";
}

export interface LeafletMapProps {
  /** O motoboy: marcador dourado com pulso; `radiusM` desenha a área quando aproximado. */
  courier: (MapPoint & { radiusM: number | null }) | null;
  pins?: MapPin[];
  trail?: MapPoint[];
  /** O mapa acompanha o motoboy quando ele se move — até a pessoa arrastar o mapa (botão "Centralizar" religa). */
  follow?: boolean;
  /** Centro inicial sem motoboy (ex.: a loja); sem nada, Belém. */
  fallbackCenter?: MapPoint;
  className?: string;
  ariaLabel?: string;
}

const DEFAULT_CENTER: MapPoint = { lat: -1.4558, lng: -48.4902 };
const TILES = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

const courierIcon = L.divIcon({
  className: "",
  html: '<span class="live-map-courier"><span class="live-map-courier-pulse"></span><span class="live-map-courier-dot"></span></span>',
  iconSize: [28, 28],
  iconAnchor: [14, 14],
});

function pinIcon(pin: MapPin): L.DivIcon {
  const color = pin.tone === "done" ? "#33573f" : pin.tone === "failed" ? "#7c3129" : pin.tone === "muted" ? "#806c64" : "#6f561b";
  return L.divIcon({
    className: "",
    html: `<span class="live-map-pin" style="--pin:${color}">${escapeHtml(pin.label)}</span>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

export function LeafletMap({ courier, pins = [], trail = [], follow = true, fallbackCenter, className, ariaLabel }: LeafletMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const courierMarkerRef = useRef<L.Marker | null>(null);
  const courierAreaRef = useRef<L.Circle | null>(null);
  const pinsLayerRef = useRef<L.LayerGroup | null>(null);
  const trailRef = useRef<L.Polyline | null>(null);
  const fittedRef = useRef(false);
  const lastFollowedRef = useRef<string | null>(null);
  const [userMoved, setUserMoved] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || mapRef.current) return;
    const center = courier ?? fallbackCenter ?? DEFAULT_CENTER;
    const map = L.map(container, { zoomControl: false, attributionControl: true, scrollWheelZoom: false }).setView([center.lat, center.lng], 15);
    L.tileLayer(TILES, { attribution: ATTRIBUTION, maxZoom: 19 }).addTo(map);
    L.control.zoom({ position: "bottomright" }).addTo(map);
    pinsLayerRef.current = L.layerGroup().addTo(map);
    trailRef.current = L.polyline([], { color: "#6f561b", weight: 3, opacity: 0.6, dashArray: "6 6" }).addTo(map);
    // Arrastou o mapa: para de seguir o motoboy até tocar em "Centralizar".
    map.on("dragstart", () => setUserMoved(true));
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      courierMarkerRef.current = null;
      courierAreaRef.current = null;
      pinsLayerRef.current = null;
      trailRef.current = null;
      fittedRef.current = false;
      lastFollowedRef.current = null;
    };
    // Só na montagem: as atualizações vêm pelos efeitos abaixo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!courier) {
      courierMarkerRef.current?.remove();
      courierAreaRef.current?.remove();
      courierMarkerRef.current = null;
      courierAreaRef.current = null;
      return;
    }
    const latLng: L.LatLngExpression = [courier.lat, courier.lng];
    if (!courierMarkerRef.current) {
      courierMarkerRef.current = L.marker(latLng, { icon: courierIcon, zIndexOffset: 1000, keyboard: false }).addTo(map);
    } else {
      courierMarkerRef.current.setLatLng(latLng);
    }
    if (courier.radiusM && courier.radiusM > 0) {
      if (!courierAreaRef.current) {
        courierAreaRef.current = L.circle(latLng, { radius: courier.radiusM, color: "#b89153", weight: 1, fillColor: "#b89153", fillOpacity: 0.12 }).addTo(map);
      } else {
        courierAreaRef.current.setLatLng(latLng).setRadius(courier.radiusM);
      }
    } else {
      courierAreaRef.current?.remove();
      courierAreaRef.current = null;
    }
    // Só recentra quando a posição realmente mudou e a pessoa não arrastou o mapa.
    const key = `${courier.lat.toFixed(5)},${courier.lng.toFixed(5)}`;
    if (follow && !userMoved && key !== lastFollowedRef.current) {
      lastFollowedRef.current = key;
      map.panTo(latLng, { animate: true, duration: 0.6 });
    }
  }, [courier, follow, userMoved]);

  const recenter = () => {
    const map = mapRef.current;
    if (!map || !courier) return;
    setUserMoved(false);
    lastFollowedRef.current = `${courier.lat.toFixed(5)},${courier.lng.toFixed(5)}`;
    map.panTo([courier.lat, courier.lng], { animate: true, duration: 0.6 });
  };

  useEffect(() => {
    const map = mapRef.current;
    const layer = pinsLayerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    for (const pin of pins) L.marker([pin.lat, pin.lng], { icon: pinIcon(pin), keyboard: false, title: pin.label }).addTo(layer);
    if (!fittedRef.current && pins.length > 0) {
      const points: L.LatLngExpression[] = [...pins.map((p) => [p.lat, p.lng] as L.LatLngExpression), ...(courier ? [[courier.lat, courier.lng] as L.LatLngExpression] : [])];
      map.fitBounds(L.latLngBounds(points), { padding: [32, 32], maxZoom: 16 });
      fittedRef.current = true;
    }
  }, [pins, courier]);

  useEffect(() => {
    trailRef.current?.setLatLngs(trail.map((p) => [p.lat, p.lng] as L.LatLngExpression));
  }, [trail]);

  return (
    <div className={`${className ?? ""} relative`}>
      <div ref={containerRef} role="region" aria-label={ariaLabel ?? "Mapa"} className="h-full w-full" />
      {follow && userMoved && courier ? (
        <button
          type="button"
          onClick={recenter}
          className="absolute top-2 left-2 z-[500] rounded-full border border-ivory-300 bg-ivory-50/95 px-3 py-1.5 text-xs font-medium text-ink-900 shadow"
        >
          Centralizar no motoboy
        </button>
      ) : null}
      <style>{`
        .live-map-courier{position:relative;display:block;width:28px;height:28px}
        .live-map-courier-pulse{position:absolute;inset:0;border-radius:9999px;background:#c9a55a;opacity:.35;animation:live-map-pulse 1.8s ease-out infinite}
        .live-map-courier-dot{position:absolute;inset:7px;border-radius:9999px;background:#6f561b;border:2px solid #faf7f0;box-shadow:0 1px 4px rgba(0,0,0,.35)}
        .live-map-pin{display:flex;width:26px;height:26px;align-items:center;justify-content:center;border-radius:9999px;background:var(--pin);color:#faf7f0;font:600 12px/1 system-ui,sans-serif;border:2px solid #faf7f0;box-shadow:0 1px 4px rgba(0,0,0,.35)}
        @keyframes live-map-pulse{0%{transform:scale(.6);opacity:.5}100%{transform:scale(1.6);opacity:0}}
        @media (prefers-reduced-motion: reduce){.live-map-courier-pulse{animation:none;opacity:.25}}
      `}</style>
    </div>
  );
}
