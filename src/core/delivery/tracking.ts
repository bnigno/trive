// O que a cliente vê da entrega — PURO. A partir da saída (última posição,
// sinal) e da parada dela (destino geocodificado, prova), monta a leitura:
// "saindo", "a caminho, a 2,1 km · ~8 min", "chegando", "entregue às 17:42".
// Nunca inclui o endereço nem as coordenadas do destino: a página do pedido
// circula em encaminhamentos. E enquanto o motoboy ainda tem OUTRAS paradas,
// a posição vai arredondada (~110 m): o ponto exato onde ele parou seria o
// endereço de outra cliente. Sem sinal há mais de 30 min, a posição some.
import { courierSignal, haversineKm, type CourierSignal, type GeoPoint } from "./positions";
import type { RunStatus, StopStatus } from "./state";

/** Velocidade média de moto na cidade, com o fator de rua (linha reta × 1,3). */
export const ETA_ROAD_FACTOR = 1.3;
export const ETA_SPEED_KMH = 20;
/** Abaixo disso o motoboy "está chegando" — só com GPS preciso o bastante para afirmar. */
export const ARRIVING_KM = 0.3;
export const ARRIVING_MAX_ACCURACY_M = 100;
/** Sem amostra nova há tanto tempo, a posição sai do link público (saída esquecida aberta). */
export const POSITION_HIDE_AFTER_MS = 30 * 60_000;
/** Casas decimais da posição enquanto há outras paradas por entregar (3 ≈ 110 m). */
export const COARSE_DECIMALS = 3;
/** Depois que outra parada fecha, o motoboy ainda está na porta dela: posição arredondada por mais um tempo. */
export const COARSE_GRACE_MS = 10 * 60_000;

export function etaMinutes(distanceKm: number): number {
  const minutes = ((distanceKm * ETA_ROAD_FACTOR) / ETA_SPEED_KMH) * 60;
  return Math.max(1, Math.ceil(minutes));
}

export type TrackingState = "waiting" | "en_route" | "arriving" | "delivered" | "failed" | "finished";

export interface TrackingRunInput {
  status: RunStatus;
  courierFirstName: string;
  /** `seenAt` = quando a amostra chegou ao servidor (o relógio do celular não entra aqui). */
  lastPosition: (GeoPoint & { accuracyM: number | null; seenAt: Date }) | null;
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
  /** Só enquanto a saída está na rua e a parada por entregar; arredondada se há outras paradas. */
  courier: (GeoPoint & { accuracyM: number | null }) | null;
  /** Posição arredondada (outras paradas) ou GPS impreciso: o mapa mostra uma área, não um ponto. */
  approximate: boolean;
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

/**
 * A parada "não consegui" ficou para trás quando o pedido saiu de novo depois
 * dela (a dona reagendou e deu o "Saiu" sem motoboy): a cliente não deve ver
 * o "não conseguimos entregar" da vez passada.
 */
export function isFromEarlierAttempt(stop: { status: StopStatus; closedAt: Date }, dispatchedAt: Date | null): boolean {
  return stop.status === "failed" && dispatchedAt !== null && dispatchedAt.getTime() > stop.closedAt.getTime();
}

export function buildTrackingView(input: {
  run: TrackingRunInput;
  stop: TrackingStopInput;
  otherStopsPending: number;
  /** Há quanto tempo a última OUTRA parada da saída fechou (null = nenhuma fechou). */
  otherStopClosedAgoMs?: number | null;
  /** Semente do deslocamento da grade de arredondamento (a saída): ver coarsePoint. */
  coarseSeed?: string;
  now: Date;
}): TrackingView {
  const { run, stop, now } = input;
  const base: TrackingView = {
    state: "waiting",
    courierFirstName: run.courierFirstName,
    courier: null,
    approximate: false,
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

  const signal = courierSignal(run.lastPosition?.seenAt ?? null, now);
  const position = run.lastPosition;
  if (!position || signal === "none") return { ...base, state: "en_route", signal };
  const ageMs = now.getTime() - position.seenAt.getTime();
  const updatedSecondsAgo = Math.max(0, Math.round(ageMs / 1000));
  if (ageMs > POSITION_HIDE_AFTER_MS) return { ...base, state: "en_route", signal, updatedSecondsAgo };

  const distanceKm = stop.destination ? round1(haversineKm(position, stop.destination)) : null;
  const preciseEnough = position.accuracyM === null || position.accuracyM <= ARRIVING_MAX_ACCURACY_M;
  const arriving = distanceKm !== null && distanceKm < ARRIVING_KM && signal !== "lost" && preciseEnough;
  const closedAgo = input.otherStopClosedAgoMs ?? null;
  const coarse = input.otherStopsPending > 0 || (closedAgo !== null && closedAgo < COARSE_GRACE_MS);
  const shown = coarse ? coarsePoint(position, input.coarseSeed ?? "") : position;
  return {
    ...base,
    state: arriving ? "arriving" : "en_route",
    courier: { lat: shown.lat, lng: shown.lng, accuracyM: position.accuracyM },
    approximate: coarse || !preciseEnough,
    signal,
    updatedSecondsAgo,
    distanceKm,
    etaMinutes: distanceKm !== null && !arriving ? etaMinutes(distanceKm) : null,
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** FNV-1a de 32 bits → [0, 1). Determinístico por semente; sem aleatoriedade no core. */
function hashUnit(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash / 0x100000000;
}

/**
 * A célula de ~110 m, com a grade deslocada por saída: sem o deslocamento, o
 * jitter do GPS na fronteira de uma célula alterna entre duas e entrega a
 * linha exata; com ele, cada saída tem uma grade própria e a fronteira não
 * é conhecida de fora.
 */
export function coarsePoint(point: GeoPoint, seed: string): GeoPoint {
  const cell = 10 ** -COARSE_DECIMALS;
  const offLat = hashUnit(`${seed}:lat`) * cell;
  const offLng = hashUnit(`${seed}:lng`) * cell;
  return {
    lat: roundTo(roundTo(point.lat + offLat, COARSE_DECIMALS) - offLat, 6),
    lng: roundTo(roundTo(point.lng + offLng, COARSE_DECIMALS) - offLng, 6),
  };
}

/** "2,1 km" / "850 m" para a legenda. */
export function distanceLabel(distanceKm: number): string {
  if (distanceKm < 1) return `${Math.max(50, Math.round((distanceKm * 1000) / 50) * 50)} m`;
  return `${distanceKm.toFixed(1).replace(".", ",")} km`;
}
