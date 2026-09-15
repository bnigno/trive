// O que a cliente vê da entrega — PURO. A partir da saída (última posição,
// sinal) e da parada dela (destino geocodificado, prova), monta a leitura:
// "saindo", "a caminho, a 2,1 km · ~8 min", "chegando", "entregue às 17:42".
// Nunca inclui o endereço nem as coordenadas do destino: a página do pedido
// circula em encaminhamentos, e a posição do motoboy já é o bastante.
import { courierSignal, haversineKm, type CourierSignal, type GeoPoint } from "./positions";
import type { RunStatus, StopStatus } from "./state";

/** Velocidade média de moto na cidade, com o fator de rua (linha reta × 1,3). */
export const ETA_ROAD_FACTOR = 1.3;
export const ETA_SPEED_KMH = 20;
/** Abaixo disso o motoboy "está chegando". */
export const ARRIVING_KM = 0.3;

export function etaMinutes(distanceKm: number): number {
  const minutes = ((distanceKm * ETA_ROAD_FACTOR) / ETA_SPEED_KMH) * 60;
  return Math.max(1, Math.ceil(minutes));
}

export type TrackingState = "waiting" | "en_route" | "arriving" | "delivered" | "failed" | "finished";

export interface TrackingRunInput {
  status: RunStatus;
  courierFirstName: string;
  lastPosition: (GeoPoint & { accuracyM: number | null; recordedAt: Date }) | null;
}

export interface TrackingStopInput {
  status: StopStatus;
  destination: GeoPoint | null;
  deliveredAt: Date | null;
  receivedBy: string | null;
}

export interface TrackingView {
  state: TrackingState;
  courierFirstName: string;
  /** Só enquanto a saída está na rua e a parada por entregar. */
  courier: (GeoPoint & { accuracyM: number | null }) | null;
  signal: CourierSignal;
  /** Segundos desde a última posição (null sem posição). */
  updatedSecondsAgo: number | null;
  /** Linha reta até a cliente, quando o destino foi geocodificado. */
  distanceKm: number | null;
  etaMinutes: number | null;
  /** Outras paradas ainda por entregar nesta saída. */
  otherStopsPending: number;
  deliveredAt: Date | null;
  receivedBy: string | null;
}

export function buildTrackingView(input: {
  run: TrackingRunInput;
  stop: TrackingStopInput;
  otherStopsPending: number;
  now: Date;
}): TrackingView {
  const { run, stop, now } = input;
  const base: TrackingView = {
    state: "waiting",
    courierFirstName: run.courierFirstName,
    courier: null,
    signal: "none",
    updatedSecondsAgo: null,
    distanceKm: null,
    etaMinutes: null,
    otherStopsPending: input.otherStopsPending,
    deliveredAt: null,
    receivedBy: null,
  };
  if (stop.status === "delivered") return { ...base, state: "delivered", deliveredAt: stop.deliveredAt, receivedBy: stop.receivedBy };
  if (stop.status === "failed") return { ...base, state: "failed" };
  if (stop.status === "canceled" || run.status === "finished" || run.status === "canceled") return { ...base, state: "finished" };
  if (run.status === "ready") return base;

  const signal = courierSignal(run.lastPosition?.recordedAt ?? null, now);
  const position = run.lastPosition;
  if (!position || signal === "none") return { ...base, state: "en_route", signal };

  const distanceKm = stop.destination ? round1(haversineKm(position, stop.destination)) : null;
  const arriving = distanceKm !== null && distanceKm < ARRIVING_KM && signal !== "lost";
  return {
    ...base,
    state: arriving ? "arriving" : "en_route",
    courier: { lat: position.lat, lng: position.lng, accuracyM: position.accuracyM },
    signal,
    updatedSecondsAgo: Math.max(0, Math.round((now.getTime() - position.recordedAt.getTime()) / 1000)),
    distanceKm,
    etaMinutes: distanceKm !== null && !arriving ? etaMinutes(distanceKm) : null,
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** "2,1 km" / "850 m" para a legenda. */
export function distanceLabel(distanceKm: number): string {
  if (distanceKm < 1) return `${Math.max(50, Math.round((distanceKm * 1000) / 50) * 50)} m`;
  return `${distanceKm.toFixed(1).replace(".", ",")} km`;
}
