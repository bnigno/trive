// A leitura da entrega pela rede: datas em ISO, o mesmo Zod nos dois lados,
// estados finais param o polling.
import { describe, expect, it } from "vitest";

import { buildTrackingView } from "@/core/delivery/tracking";
import { isTrackingFinal, serializeTrackingView, trackingViewJsonSchema } from "@/core/delivery/tracking-json";

const NOW = new Date("2026-09-18T18:00:00Z");

describe("tracking-json", () => {
  it("serializa e valida de volta (ida e volta sem perda)", () => {
    const view = buildTrackingView({
      run: { status: "en_route", courierFirstName: "Carlos", lastPosition: { lat: -1.45, lng: -48.49, accuracyM: 9, seenAt: new Date(NOW.getTime() - 10_000) } },
      stop: { status: "pending", destination: { lat: -1.455, lng: -48.493 }, deliveredAt: null, receivedBy: null },
      otherStopsPending: 1,
      coarseSeed: "run",
      now: NOW,
    });
    const json = serializeTrackingView(view);
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
    expect(trackingViewJsonSchema.parse(JSON.parse(JSON.stringify(json)))).toEqual(json);
    const delivered = serializeTrackingView(
      buildTrackingView({ run: { status: "en_route", courierFirstName: "Carlos", lastPosition: null }, stop: { status: "delivered", destination: null, deliveredAt: NOW, receivedBy: "Maria" }, otherStopsPending: 0, now: NOW }),
    );
    expect(delivered.deliveredAt).toBe(NOW.toISOString());
    expect(trackingViewJsonSchema.safeParse({ ...json, state: "voando" }).success).toBe(false);
  });

  it("estados finais param o polling", () => {
    expect(isTrackingFinal("delivered")).toBe(true);
    expect(isTrackingFinal("failed")).toBe(true);
    expect(isTrackingFinal("finished")).toBe(true);
    expect(isTrackingFinal("en_route")).toBe(false);
    expect(isTrackingFinal("waiting")).toBe(false);
  });
});
