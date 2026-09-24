// O que a cliente vê (puro): estados por fase da saída e da parada, ETA,
// "chegando", sinal perdido — e nunca o destino.
import { describe, expect, it } from "vitest";

import {
  buildTrackingView,
  COARSE_DECIMALS,
  COARSE_GRACE_MS,
  coarsePoint,
  distanceLabel,
  etaMinutes,
  isFromEarlierAttempt,
  POSITION_HIDE_AFTER_MS,
  type TrackingRunInput,
  type TrackingStopInput,
} from "@/core/delivery/tracking";

const NOW = new Date("2026-09-18T18:00:00Z");
const DEST = { lat: -1.4553, lng: -48.4933 };
/** ≈ 2,2 km ao norte do destino. */
const FAR = { lat: DEST.lat + 0.02, lng: DEST.lng };
/** ≈ 110 m ao norte. */
const NEAR = { lat: DEST.lat + 0.001, lng: DEST.lng };

function run(over: Partial<TrackingRunInput> = {}): TrackingRunInput {
  return { status: "en_route", courierFirstName: "Carlos", lastPosition: { ...FAR, accuracyM: 10, seenAt: new Date(NOW.getTime() - 15_000) }, ...over };
}
function stop(over: Partial<TrackingStopInput> = {}): TrackingStopInput {
  return { status: "pending", destination: DEST, deliveredAt: null, receivedBy: null, ...over };
}

describe("etaMinutes", () => {
  it("20 km/h com fator de rua 1,3, nunca abaixo de 1 min", () => {
    expect(etaMinutes(2)).toBe(8);
    expect(etaMinutes(0.1)).toBe(1);
    expect(etaMinutes(10)).toBe(39);
  });

  it("distanceLabel arredonda: metros de 50 em 50, km com uma casa", () => {
    expect(distanceLabel(0.112)).toBe("100 m");
    expect(distanceLabel(0.02)).toBe("50 m");
    expect(distanceLabel(2.24)).toBe("2,2 km");
  });
});

describe("buildTrackingView", () => {
  it("saída pronta: esperando, sem posição", () => {
    const view = buildTrackingView({ run: run({ status: "ready", lastPosition: null }), stop: stop(), otherStopsPending: 2, now: NOW });
    expect(view.state).toBe("waiting");
    expect(view.courier).toBeNull();
    expect(view.otherStopsPending).toBe(2);
    expect(view.courierFirstName).toBe("Carlos");
  });

  it("na rua: posição, distância, ETA e sinal; sem destino geocodificado fica só a posição", () => {
    const view = buildTrackingView({ run: run(), stop: stop(), otherStopsPending: 0, now: NOW });
    expect(view.state).toBe("en_route");
    expect(view.courier).toEqual({ ...FAR, accuracyM: 10 });
    expect(view.distanceKm).toBeCloseTo(2.2, 1);
    expect(view.etaMinutes).toBe(etaMinutes(view.distanceKm!));
    expect(view.signal).toBe("live");
    expect(view.updatedSecondsAgo).toBe(15);
    expect(view).not.toHaveProperty("destination");

    const noDest = buildTrackingView({ run: run(), stop: stop({ destination: null }), otherStopsPending: 0, now: NOW });
    expect(noDest.state).toBe("en_route");
    expect(noDest.distanceKm).toBeNull();
    expect(noDest.etaMinutes).toBeNull();
    expect(noDest.courier).not.toBeNull();
  });

  it("a menos de 300 m está chegando (sem ETA); com sinal perdido não afirma que chega", () => {
    const arriving = buildTrackingView({ run: run({ lastPosition: { ...NEAR, accuracyM: 8, seenAt: NOW } }), stop: stop(), otherStopsPending: 0, now: NOW });
    expect(arriving.state).toBe("arriving");
    expect(arriving.etaMinutes).toBeNull();
    expect(arriving.approximate).toBe(false);
    const lost = buildTrackingView(
      { run: run({ lastPosition: { ...NEAR, accuracyM: 8, seenAt: new Date(NOW.getTime() - 10 * 60_000) } }), stop: stop(), otherStopsPending: 0, now: NOW },
    );
    expect(lost.state).toBe("en_route");
    expect(lost.signal).toBe("lost");
    expect(lost.courier).not.toBeNull();
  });

  it("'chegando' só com GPS preciso: a 110 m com erro de 400 m é 'a caminho, aproximado'", () => {
    const view = buildTrackingView({ run: run({ lastPosition: { ...NEAR, accuracyM: 400, seenAt: NOW } }), stop: stop(), otherStopsPending: 0, now: NOW });
    expect(view.state).toBe("en_route");
    expect(view.approximate).toBe(true);
    expect(view.courier?.accuracyM).toBe(400);
  });

  it("com outras paradas por entregar a posição vai arredondada (~110 m, grade deslocada por saída): o ponto exato seria a casa de outra cliente", () => {
    const exact = { lat: -1.455312, lng: -48.493287 };
    const view = buildTrackingView({ run: run({ lastPosition: { ...exact, accuracyM: 8, seenAt: NOW } }), stop: stop(), otherStopsPending: 2, coarseSeed: "saida-1", now: NOW });
    expect(view.approximate).toBe(true);
    expect(view.courier?.accuracyM).toBe(8);
    expect(view.courier).not.toMatchObject({ lat: exact.lat, lng: exact.lng });
    const cell = 10 ** -COARSE_DECIMALS;
    expect(Math.abs(view.courier!.lat - exact.lat)).toBeLessThanOrEqual(cell);
    expect(Math.abs(view.courier!.lng - exact.lng)).toBeLessThanOrEqual(cell);
    // Determinístico por saída; outra saída, outra grade.
    const again = buildTrackingView({ run: run({ lastPosition: { ...exact, accuracyM: 8, seenAt: NOW } }), stop: stop(), otherStopsPending: 2, coarseSeed: "saida-1", now: NOW });
    expect(again.courier).toEqual(view.courier);
    expect(coarsePoint(exact, "saida-2")).not.toEqual(coarsePoint(exact, "saida-1"));
    // Jitter de 5 m na fronteira de uma célula "redonda" não alterna a célula deslocada.
    const border = { lat: -1.4565, lng: -48.4935 };
    expect(coarsePoint({ lat: border.lat + 0.00004, lng: border.lng }, "saida-1")).toEqual(coarsePoint({ lat: border.lat - 0.00004, lng: border.lng }, "saida-1"));
    // A distância e o ETA continuam calculados sobre a posição exata.
    expect(view.distanceKm).toBeCloseTo(0, 1);
    const alone = buildTrackingView({ run: run({ lastPosition: { ...exact, accuracyM: 8, seenAt: NOW } }), stop: stop(), otherStopsPending: 0, now: NOW });
    expect(alone.courier).toEqual({ ...exact, accuracyM: 8 });
    expect(alone.approximate).toBe(false);
  });

  it("depois que outra parada fecha, a posição continua arredondada por 10 min (o motoboy ainda está na porta dela)", () => {
    const exact = { lat: -1.455312, lng: -48.493287 };
    const justClosed = buildTrackingView({ run: run({ lastPosition: { ...exact, accuracyM: 8, seenAt: NOW } }), stop: stop(), otherStopsPending: 0, otherStopClosedAgoMs: 30_000, coarseSeed: "s", now: NOW });
    expect(justClosed.approximate).toBe(true);
    expect(justClosed.courier).not.toMatchObject({ lat: exact.lat });
    const later = buildTrackingView({ run: run({ lastPosition: { ...exact, accuracyM: 8, seenAt: NOW } }), stop: stop(), otherStopsPending: 0, otherStopClosedAgoMs: COARSE_GRACE_MS, coarseSeed: "s", now: NOW });
    expect(later.approximate).toBe(false);
    expect(later.courier).toEqual({ ...exact, accuracyM: 8 });
  });

  it("sem amostra nova há mais de 30 min a posição some do link (saída esquecida aberta)", () => {
    const stale = buildTrackingView({ run: run({ lastPosition: { ...FAR, accuracyM: 8, seenAt: new Date(NOW.getTime() - POSITION_HIDE_AFTER_MS - 1) } }), stop: stop(), otherStopsPending: 0, now: NOW });
    expect(stale).toMatchObject({ state: "en_route", signal: "lost", courier: null, distanceKm: null });
    expect(stale.updatedSecondsAgo).toBeGreaterThanOrEqual(1800);
  });

  it("na rua sem posição ainda: a caminho, sem sinal", () => {
    const view = buildTrackingView({ run: run({ lastPosition: null }), stop: stop(), otherStopsPending: 1, now: NOW });
    expect(view.state).toBe("en_route");
    expect(view.signal).toBe("none");
    expect(view.courier).toBeNull();
  });

  it("entregue, não entregue e saída fechada não expõem posição", () => {
    const delivered = buildTrackingView({ run: run(), stop: stop({ status: "delivered", deliveredAt: NOW, receivedBy: "Maria" }), otherStopsPending: 0, now: NOW });
    expect(delivered).toMatchObject({ state: "delivered", deliveredAt: NOW, receivedBy: "Maria", courier: null });
    expect(buildTrackingView({ run: run(), stop: stop({ status: "failed" }), otherStopsPending: 0, now: NOW })).toMatchObject({ state: "failed", courier: null });
    expect(buildTrackingView({ run: run({ status: "finished" }), stop: stop(), otherStopsPending: 0, now: NOW })).toMatchObject({ state: "finished", courier: null });
    expect(buildTrackingView({ run: run({ status: "canceled" }), stop: stop({ status: "canceled" }), otherStopsPending: 0, now: NOW }).state).toBe("finished");
  });
});

describe("isFromEarlierAttempt", () => {
  const failedAt = new Date("2026-09-18T20:00:00Z");
  it("'não consegui' e o pedido saiu de novo depois: é da vez passada", () => {
    expect(isFromEarlierAttempt({ status: "failed", closedAt: failedAt }, new Date("2026-09-20T18:00:00Z"))).toBe(true);
  });
  it("falhou depois da saída (a de agora), ainda não saiu de novo, ou não falhou: vale", () => {
    expect(isFromEarlierAttempt({ status: "failed", closedAt: failedAt }, new Date("2026-09-18T19:00:00Z"))).toBe(false);
    expect(isFromEarlierAttempt({ status: "failed", closedAt: failedAt }, null)).toBe(false);
    expect(isFromEarlierAttempt({ status: "delivered", closedAt: failedAt }, new Date("2026-09-20T18:00:00Z"))).toBe(false);
    expect(isFromEarlierAttempt({ status: "pending", closedAt: failedAt }, new Date("2026-09-20T18:00:00Z"))).toBe(false);
  });
});
