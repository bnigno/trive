// Posições do motoboy — PURO. Que amostra do GPS vale guardar, o que é
// ruído (hora no futuro, ponto mais velho que o anterior, precisão de
// quilômetro), quando a trilha ganha um ponto novo e o que "sinal" quer
// dizer para quem olha o mapa. `now` é sempre injetado.

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface PositionSample extends GeoPoint {
  /** Raio de erro do GPS em metros (null quando o celular não informa). */
  accuracyM: number | null;
  /** A hora do GPS no celular. */
  recordedAt: Date;
}

/** Amostra que o servidor recusa: nunca chega ao mapa. */
export const POSITION_MAX_FUTURE_MS = 60_000;
/** Precisão pior que isso é célula de operadora, não GPS: ignora. */
export const POSITION_MAX_ACCURACY_M = 1_000;
/** A trilha guarda um ponto a cada 15 s ou 25 m — o suficiente para desenhar o caminho. */
export const TRAIL_MIN_INTERVAL_MS = 15_000;
export const TRAIL_MIN_DISTANCE_M = 25;
/** O celular só manda quando andou 10 m ou passaram 5 s: poupa bateria e banco. */
export const SEND_MIN_INTERVAL_MS = 5_000;
export const SEND_MIN_DISTANCE_M = 10;

const EARTH_RADIUS_KM = 6_371.0088;

export function isValidPoint(point: { lat: number; lng: number }): boolean {
  return (
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lng) &&
    Math.abs(point.lat) <= 90 &&
    Math.abs(point.lng) <= 180 &&
    !(point.lat === 0 && point.lng === 0)
  );
}

/** Distância em linha reta (haversine), em km. */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type PositionRejectReason = "invalid" | "future" | "regression" | "inaccurate";

export type PositionDecision = { kind: "reject"; reason: PositionRejectReason } | { kind: "accept"; trail: boolean };

/**
 * Decide o que fazer com uma amostra nova, dado o último ponto GUARDADO NA
 * TRILHA (`lastTrail`) e o último aceito (`last`). A última posição da saída
 * sempre atualiza quando aceita; a trilha só ganha ponto com distância ou
 * tempo suficientes desde o último ponto da trilha.
 */
export function acceptPosition(input: {
  last: { recordedAt: Date } | null;
  lastTrail: PositionSample | null;
  sample: PositionSample;
  now: Date;
}): PositionDecision {
  const { sample } = input;
  if (!isValidPoint(sample)) return { kind: "reject", reason: "invalid" };
  if (!Number.isFinite(sample.recordedAt.getTime())) return { kind: "reject", reason: "invalid" };
  if (sample.recordedAt.getTime() - input.now.getTime() > POSITION_MAX_FUTURE_MS) return { kind: "reject", reason: "future" };
  if (input.last && sample.recordedAt.getTime() <= input.last.recordedAt.getTime()) return { kind: "reject", reason: "regression" };
  if (sample.accuracyM !== null && (!Number.isFinite(sample.accuracyM) || sample.accuracyM < 0)) return { kind: "reject", reason: "invalid" };
  if (sample.accuracyM !== null && sample.accuracyM > POSITION_MAX_ACCURACY_M) return { kind: "reject", reason: "inaccurate" };

  if (!input.lastTrail) return { kind: "accept", trail: true };
  const elapsedMs = sample.recordedAt.getTime() - input.lastTrail.recordedAt.getTime();
  const movedM = haversineKm(input.lastTrail, sample) * 1000;
  return { kind: "accept", trail: elapsedMs >= TRAIL_MIN_INTERVAL_MS || movedM >= TRAIL_MIN_DISTANCE_M };
}

/** O celular do motoboy: manda a amostra nova? (5 s ou 10 m desde a última enviada.) */
export function shouldSendSample(lastSent: PositionSample | null, sample: PositionSample): boolean {
  if (!lastSent) return true;
  const elapsedMs = sample.recordedAt.getTime() - lastSent.recordedAt.getTime();
  if (elapsedMs >= SEND_MIN_INTERVAL_MS) return true;
  return haversineKm(lastSent, sample) * 1000 >= SEND_MIN_DISTANCE_M;
}

/** live: acabou de chegar · stale: há 1–3 min · lost: mais que isso · none: nunca veio. */
export type CourierSignal = "live" | "stale" | "lost" | "none";
export const SIGNAL_LIVE_MS = 60_000;
export const SIGNAL_STALE_MS = 180_000;

export function courierSignal(lastPositionAt: Date | null, now: Date): CourierSignal {
  if (!lastPositionAt) return "none";
  const age = now.getTime() - lastPositionAt.getTime();
  if (age <= SIGNAL_LIVE_MS) return "live";
  if (age <= SIGNAL_STALE_MS) return "stale";
  return "lost";
}

/** "há 2 min" / "agora" para a legenda do sinal. */
export function signalAgeLabel(lastPositionAt: Date | null, now: Date): string | null {
  if (!lastPositionAt) return null;
  const seconds = Math.max(0, Math.round((now.getTime() - lastPositionAt.getTime()) / 1000));
  if (seconds < 45) return "agora";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `há ${hours} h`;
}
