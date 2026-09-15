// O corpo que o celular do motoboy manda a cada amostra do GPS. Puro: a rota
// e o teste usam o mesmo Zod.
import { z } from "zod";

export const positionBodySchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).max(100_000).nullable().optional(),
  speedMps: z.number().min(0).max(200).nullable().optional(),
  /** ISO da hora do GPS no celular (o servidor apara ao próprio relógio). */
  recordedAt: z.iso.datetime({ offset: true }),
});

export type PositionBody = z.infer<typeof positionBodySchema>;
