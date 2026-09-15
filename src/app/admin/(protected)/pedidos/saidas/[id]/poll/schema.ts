// O que o mapa ao vivo do painel pergunta a cada 5 s: posição do motoboy,
// pinos das paradas e a trilha. Puro; a rota serializa e o componente valida.
import { z } from "zod";

import type { DeliveryRunDetail } from "@/services/delivery-runs";

export const runLiveSchema = z.object({
  status: z.enum(["ready", "en_route", "finished", "canceled"]),
  lastPosition: z.object({ lat: z.number(), lng: z.number(), accuracyM: z.number().nullable(), seenAt: z.string() }).nullable(),
  stops: z.array(
    z.object({
      sequence: z.number(),
      status: z.enum(["pending", "delivered", "failed", "canceled"]),
      destination: z.object({ lat: z.number(), lng: z.number() }).nullable(),
      deliveredPoint: z.object({ lat: z.number(), lng: z.number() }).nullable(),
    }),
  ),
  trail: z.array(z.object({ lat: z.number(), lng: z.number() })),
});

export type RunLive = z.infer<typeof runLiveSchema>;

export function serializeRunLive(run: DeliveryRunDetail): RunLive {
  return {
    status: run.status,
    lastPosition: run.lastPosition ? { lat: run.lastPosition.lat, lng: run.lastPosition.lng, accuracyM: run.lastPosition.accuracyM, seenAt: run.lastPosition.recordedAt.toISOString() } : null,
    stops: run.stops.map((stop) => ({
      sequence: stop.sequence,
      status: stop.status,
      destination: stop.destination,
      deliveredPoint: stop.deliveredPoint ? { lat: stop.deliveredPoint.lat, lng: stop.deliveredPoint.lng } : null,
    })),
    trail: run.trail.map((p) => ({ lat: p.lat, lng: p.lng })),
  };
}
