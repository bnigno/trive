// Amostras do GPS (puro): distância, o que o servidor recusa, quando a
// trilha ganha ponto, quando o celular manda e o que "sinal" quer dizer.
import { describe, expect, it } from "vitest";

import {
  acceptPosition,
  courierSignal,
  haversineKm,
  isValidPoint,
  shouldSendSample,
  signalAgeLabel,
  type PositionSample,
} from "@/core/delivery/positions";

// Belém: Praça da República → Estação das Docas ≈ 1,2 km em linha reta.
const REPUBLICA = { lat: -1.4553, lng: -48.4933 };
const DOCAS = { lat: -1.4489, lng: -48.5013 };
const NOW = new Date("2026-09-18T18:00:00Z");

function sample(over: Partial<PositionSample> & { secondsAgo?: number } = {}): PositionSample {
  const { secondsAgo = 0, ...rest } = over;
  return { lat: REPUBLICA.lat, lng: REPUBLICA.lng, accuracyM: 12, recordedAt: new Date(NOW.getTime() - secondsAgo * 1000), ...rest };
}

/** Desloca um ponto `meters` metros para o norte. */
function north(point: { lat: number; lng: number }, meters: number) {
  return { lat: point.lat + meters / 111_320, lng: point.lng };
}

describe("haversineKm", () => {
  it("mede a distância em linha reta com precisão de dezenas de metros", () => {
    expect(haversineKm(REPUBLICA, DOCAS)).toBeCloseTo(1.13, 1);
    expect(haversineKm(REPUBLICA, REPUBLICA)).toBe(0);
    expect(haversineKm(REPUBLICA, north(REPUBLICA, 1000))).toBeCloseTo(1, 2);
  });

  it("ponto válido: dentro dos limites e não (0, 0)", () => {
    expect(isValidPoint(REPUBLICA)).toBe(true);
    expect(isValidPoint({ lat: 91, lng: 0 })).toBe(false);
    expect(isValidPoint({ lat: 0, lng: 181 })).toBe(false);
    expect(isValidPoint({ lat: 0, lng: 0 })).toBe(false);
    expect(isValidPoint({ lat: Number.NaN, lng: 1 })).toBe(false);
  });
});

describe("acceptPosition", () => {
  it("primeira amostra: aceita e abre a trilha", () => {
    const decision = acceptPosition({ lastTrail: null, sample: sample(), now: NOW });
    expect(decision).toEqual({ kind: "accept", trail: true, recordedAt: NOW });
  });

  it("recusa ponto inválido e regressão de tempo contra o último ponto da trilha", () => {
    expect(acceptPosition({ lastTrail: null, sample: sample({ lat: 0, lng: 0 }), now: NOW })).toEqual({ kind: "reject", reason: "invalid" });
    const lastTrail = sample({ secondsAgo: 10 });
    expect(acceptPosition({ lastTrail, sample: sample({ secondsAgo: 20 }), now: NOW })).toEqual({ kind: "reject", reason: "regression" });
    expect(acceptPosition({ lastTrail, sample: sample({ secondsAgo: 10 }), now: NOW })).toEqual({ kind: "reject", reason: "regression" });
  });

  it("relógio do celular adiantado: a hora é aparada ao relógio do servidor, nunca recusada", () => {
    const decision = acceptPosition({ lastTrail: null, sample: sample({ secondsAgo: -120 }), now: NOW });
    expect(decision).toEqual({ kind: "accept", trail: true, recordedAt: NOW });
    // A amostra seguinte (também adiantada) não é regressão: as duas caem em NOW+…
    const later = new Date(NOW.getTime() + 5_000);
    const next = acceptPosition({ lastTrail: { ...sample({ secondsAgo: -120 }), recordedAt: NOW }, sample: sample({ ...north(REPUBLICA, 30), secondsAgo: -120 }), now: later });
    expect(next).toEqual({ kind: "accept", trail: true, recordedAt: later });
  });

  it("relógio do celular atrasado: aceita (a hora dele só ordena a trilha)", () => {
    expect(acceptPosition({ lastTrail: null, sample: sample({ secondsAgo: 300 }), now: NOW }).kind).toBe("accept");
  });

  it("recusa precisão de quilômetro (célula de operadora) e precisão negativa", () => {
    expect(acceptPosition({ lastTrail: null, sample: sample({ accuracyM: 1500 }), now: NOW })).toEqual({ kind: "reject", reason: "inaccurate" });
    expect(acceptPosition({ lastTrail: null, sample: sample({ accuracyM: -1 }), now: NOW })).toEqual({ kind: "reject", reason: "invalid" });
    expect(acceptPosition({ lastTrail: null, sample: sample({ accuracyM: null }), now: NOW }).kind).toBe("accept");
  });

  it("trilha só a cada 15 s ou 25 m desde o último ponto guardado; a última posição sempre atualiza", () => {
    const lastTrail = sample({ secondsAgo: 10 });
    // 5 s depois, 5 m adiante: aceita sem trilha.
    expect(acceptPosition({ lastTrail, sample: sample({ ...north(REPUBLICA, 5), secondsAgo: 5 }), now: NOW })).toMatchObject({ kind: "accept", trail: false });
    // 5 s depois, 30 m adiante: trilha por distância.
    expect(acceptPosition({ lastTrail, sample: sample({ ...north(REPUBLICA, 30), secondsAgo: 5 }), now: NOW })).toMatchObject({ kind: "accept", trail: true });
    // 16 s depois parado: trilha por tempo.
    expect(acceptPosition({ lastTrail: sample({ secondsAgo: 20 }), sample: sample({ secondsAgo: 4 }), now: NOW })).toMatchObject({ kind: "accept", trail: true });
  });
});

describe("shouldSendSample (celular do motoboy)", () => {
  it("manda a primeira, depois só com 5 s ou 10 m", () => {
    expect(shouldSendSample(null, sample())).toBe(true);
    const sent = sample({ secondsAgo: 3 });
    expect(shouldSendSample(sent, sample({ ...north(REPUBLICA, 3) }))).toBe(false);
    expect(shouldSendSample(sent, sample({ ...north(REPUBLICA, 12) }))).toBe(true);
    expect(shouldSendSample(sample({ secondsAgo: 6 }), sample())).toBe(true);
  });
});

describe("courierSignal", () => {
  it("live até 60 s, stale até 3 min, lost depois, none sem posição", () => {
    expect(courierSignal(null, NOW)).toBe("none");
    expect(courierSignal(new Date(NOW.getTime() - 30_000), NOW)).toBe("live");
    expect(courierSignal(new Date(NOW.getTime() - 60_000), NOW)).toBe("live");
    expect(courierSignal(new Date(NOW.getTime() - 120_000), NOW)).toBe("stale");
    expect(courierSignal(new Date(NOW.getTime() - 181_000), NOW)).toBe("lost");
  });

  it("legenda: agora / há N min / há N h", () => {
    expect(signalAgeLabel(null, NOW)).toBeNull();
    expect(signalAgeLabel(new Date(NOW.getTime() - 20_000), NOW)).toBe("agora");
    expect(signalAgeLabel(new Date(NOW.getTime() - 150_000), NOW)).toBe("há 3 min");
    expect(signalAgeLabel(new Date(NOW.getTime() - 2 * 3_600_000), NOW)).toBe("há 2 h");
  });
});
