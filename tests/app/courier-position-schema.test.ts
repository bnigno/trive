// O corpo da posição do motoboy (POST /entrega/<token>/posicao): o que a
// rota aceita e recusa antes de chegar ao serviço.
import { describe, expect, it } from "vitest";

import { positionBodySchema } from "@/app/entrega/[token]/posicao/schema";

describe("positionBodySchema", () => {
  it("aceita a amostra do celular com precisão e velocidade opcionais", () => {
    const parsed = positionBodySchema.parse({ lat: -1.4558, lng: -48.4902, accuracyM: 12.5, speedMps: null, recordedAt: "2026-09-18T19:00:00.000Z" });
    expect(parsed.accuracyM).toBe(12.5);
    expect(parsed.speedMps).toBeNull();
    expect(positionBodySchema.safeParse({ lat: -1.4558, lng: -48.4902, recordedAt: "2026-09-18T16:00:00-03:00" }).success).toBe(true);
  });

  it("recusa coordenada fora do mapa, precisão negativa e hora sem formato ISO", () => {
    expect(positionBodySchema.safeParse({ lat: 91, lng: 0, recordedAt: "2026-09-18T19:00:00Z" }).success).toBe(false);
    expect(positionBodySchema.safeParse({ lat: 0, lng: 0, accuracyM: -1, recordedAt: "2026-09-18T19:00:00Z" }).success).toBe(false);
    expect(positionBodySchema.safeParse({ lat: 0, lng: 0, recordedAt: "ontem" }).success).toBe(false);
    expect(positionBodySchema.safeParse({ lat: "a", lng: 0, recordedAt: "2026-09-18T19:00:00Z" }).success).toBe(false);
  });
});
