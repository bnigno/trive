// A leitura da entrega atravessando a rede (rota JSON → componente da
// cliente): datas viram ISO, e o cliente valida o que recebe com o mesmo
// Zod. Puro.
import { z } from "zod";

import type { TrackingView } from "./tracking";

export const trackingViewJsonSchema = z.object({
  state: z.enum(["waiting", "en_route", "arriving", "delivered", "failed", "finished"]),
  courierFirstName: z.string(),
  courier: z.object({ lat: z.number(), lng: z.number(), accuracyM: z.number().nullable() }).nullable(),
  approximate: z.boolean(),
  signal: z.enum(["live", "stale", "lost", "none"]),
  updatedSecondsAgo: z.number().nullable(),
  distanceKm: z.number().nullable(),
  etaMinutes: z.number().nullable(),
  otherStopsPending: z.number(),
  deliveredAt: z.string().nullable(),
  receivedBy: z.string().nullable(),
});

export type TrackingViewJson = z.infer<typeof trackingViewJsonSchema>;

export function serializeTrackingView(view: TrackingView): TrackingViewJson {
  return { ...view, deliveredAt: view.deliveredAt?.toISOString() ?? null };
}

/** Estado final: a página para de perguntar. */
export function isTrackingFinal(state: TrackingViewJson["state"]): boolean {
  return state === "delivered" || state === "failed" || state === "finished";
}
