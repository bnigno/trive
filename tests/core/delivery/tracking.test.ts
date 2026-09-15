// O que a cliente vê (puro): estados por fase da saída e da parada, ETA,
// "chegando", sinal perdido — e nunca o destino.
import { describe, expect, it } from "vitest";

import { buildTrackingView, distanceLabel, etaMinutes, type TrackingRunInput, type TrackingStopInput } from "@/core/delivery/tracking";

const NOW = new Date("2026-09-18T18:00:00Z");
const DEST = { lat: -1.4553, lng: -48.4933 };
/** ≈ 2,2 km ao norte do destino. */
const FAR = { lat: DEST.lat + 0.02, lng: DEST.lng };
/** ≈ 110 m ao norte. */
const NEAR = { lat: DEST.lat + 0.001, lng: DEST.lng };

function run(over: Partial<TrackingRunInput> = {}): TrackingRunInput {
  return { status: "en_route", courierFirstName: "Carlos", lastPosition: { ...FAR, accuracyM: 10, recordedAt: new Date(NOW.getTime() - 15_000) }, ...over };
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
    const arriving = buildTrackingView({ run: run({ lastPosition: { ...NEAR, accuracyM: 8, recordedAt: NOW } }), stop: stop(), otherStopsPending: 0, now: NOW });
    expect(arriving.state).toBe("arriving");
    expect(arriving.etaMinutes).toBeNull();
    const lost = buildTrackingView(
      { run: run({ lastPosition: { ...NEAR, accuracyM: 8, recordedAt: new Date(NOW.getTime() - 10 * 60_000) } }), stop: stop(), otherStopsPending: 0, now: NOW },
    );
    expect(lost.state).toBe("en_route");
    expect(lost.signal).toBe("lost");
    expect(lost.courier).not.toBeNull();
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
