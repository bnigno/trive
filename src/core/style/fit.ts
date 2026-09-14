// "Vai me servir?" — PURO. As medidas do corpo (busto, cintura, quadril, em
// cm) contra a tabela de medidas da peça viram um veredito por tamanho — a
// folga em cm decide se aperta, marca, fica certo, fluido ou folgado — e uma
// recomendação de acordo com o caimento que ela prefere. Heurística fixa em
// centímetros: honesta para tecidos planos; malha muito elástica pode
// perdoar mais do que isto diz.
import { z } from "zod";

import type { SizeChartRow } from "@/core/catalog/measurements";
import type { Fit } from "@/core/style/profile";

export const BODY_KEYS = ["bustCm", "waistCm", "hipsCm"] as const;
export type BodyKey = (typeof BODY_KEYS)[number];

/** Contornos adultos em cm: abaixo disto é numeração de roupa (42, 44…), não medida. */
export const BODY_MIN_CM: Record<BodyKey, number> = { bustCm: 60, waistCm: 50, hipsCm: 60 };
export const BODY_MAX_CM = 200;
const BODY_ERROR = "Medida em centímetros de contorno (busto a partir de 60, cintura de 50, quadril de 60; até 200) — 42 é numeração, não cm.";

export const bodyMeasurementsSchema = z
  .object({
    bustCm: z.number({ error: BODY_ERROR }).min(BODY_MIN_CM.bustCm, BODY_ERROR).max(BODY_MAX_CM, BODY_ERROR).optional(),
    waistCm: z.number({ error: BODY_ERROR }).min(BODY_MIN_CM.waistCm, BODY_ERROR).max(BODY_MAX_CM, BODY_ERROR).optional(),
    hipsCm: z.number({ error: BODY_ERROR }).min(BODY_MIN_CM.hipsCm, BODY_ERROR).max(BODY_MAX_CM, BODY_ERROR).optional(),
  })
  .refine((value) => BODY_KEYS.some((key) => value[key] !== undefined), { message: "Informe ao menos uma medida." });

export type BodyMeasurements = z.infer<typeof bodyMeasurementsSchema>;

export const BODY_LABELS: Record<BodyKey, string> = { bustCm: "busto", waistCm: "cintura", hipsCm: "quadril" };
/** "no busto", "na cintura", "no quadril". */
const BODY_WHERE: Record<BodyKey, string> = { bustCm: "no busto", waistCm: "na cintura", hipsCm: "no quadril" };

/** Medida da peça ↔ medida do corpo. */
const CHART_KEY: Record<BodyKey, "bust" | "waist" | "hip"> = { bustCm: "bust", waistCm: "waist", hipsCm: "hip" };

/** Folga (peça − corpo) em cm → como fica. */
export type Ease = "aperta" | "marca" | "certo" | "fluido" | "folgado";

export const EASE_LABELS: Record<Ease, string> = {
  aperta: "aperta",
  marca: "marca",
  certo: "fica certo",
  fluido: "fica fluido",
  folgado: "fica folgado",
};

/**
 * "Peça deitada" ora é a circunferência (busto 92), ora a largura de lado a
 * lado (busto 46). A convenção é da TABELA inteira, nunca de um ponto: se a
 * maior medida de busto/cintura/quadril da tabela fica abaixo de 65 cm, ela
 * está a meio e todas as linhas são dobradas. Nenhuma circunferência de
 * roupa adulta é menor que isso; nenhuma largura a meio é maior.
 */
export const HALF_WIDTH_MAX_CM = 65;

export function chartIsHalfWidth(chart: readonly SizeChartRow[]): boolean {
  const values = chart.flatMap((row) => [row.measurements.bust, row.measurements.waist, row.measurements.hip]).filter((value): value is number => value !== undefined);
  return values.length > 0 && Math.max(...values) < HALF_WIDTH_MAX_CM;
}

export function easeOf(garmentCm: number, bodyCm: number): { ease: Ease; cm: number } {
  const cm = Math.round(garmentCm - bodyCm);
  if (cm < 0) return { ease: "aperta", cm };
  if (cm < 4) return { ease: "marca", cm };
  if (cm <= 10) return { ease: "certo", cm };
  if (cm <= 18) return { ease: "fluido", cm };
  return { ease: "folgado", cm };
}

export type SizeVerdict = {
  size: string;
  /** O pior ponto decide (apertar no quadril vale mais que ficar certo no busto). */
  overall: Ease;
  /** A folga em cada medida comparável, na ordem busto, cintura, quadril. */
  points: { key: BodyKey; ease: Ease; cm: number }[];
};

export type SizeAdvice =
  | { kind: "no_body" }
  | { kind: "no_chart" }
  | { kind: "no_overlap" }
  | { kind: "advice"; verdicts: SizeVerdict[]; recommended: string | null; fit: Fit | null };

const EASE_RANK: Record<Ease, number> = { aperta: 0, marca: 1, certo: 2, fluido: 3, folgado: 4 };

function worst(points: readonly { ease: Ease }[]): Ease {
  // "aperta" manda; depois o mais longe de "certo"; no empate, o lado do
  // desconforto (marca antes de fluido) — quem lê "fluido" não espera marcar.
  if (points.some((point) => point.ease === "aperta")) return "aperta";
  return points.reduce<Ease>((acc, point) => {
    const distance = Math.abs(EASE_RANK[point.ease] - 2);
    const current = Math.abs(EASE_RANK[acc] - 2);
    if (distance > current) return point.ease;
    if (distance === current && EASE_RANK[point.ease] < EASE_RANK[acc]) return point.ease;
    return acc;
  }, "certo");
}

/** Quantos pontos "certo" — desempate entre tamanhos com o mesmo veredito. */
function comfort(verdict: SizeVerdict): number {
  return verdict.points.filter((point) => point.ease === "certo").length;
}

/** O que cada caimento preferido considera ideal, em ordem de preferência. */
const PREFERRED: Record<Fit, Ease[]> = {
  justo: ["marca", "certo", "fluido"],
  fluido: ["fluido", "certo", "folgado"],
  tanto_faz: ["certo", "fluido", "marca"],
};

export function adviseSize(body: BodyMeasurements | null, chart: readonly SizeChartRow[], fit: Fit | null): SizeAdvice {
  if (!body || BODY_KEYS.every((key) => body[key] === undefined)) return { kind: "no_body" };
  if (chart.length === 0) return { kind: "no_chart" };
  const factor = chartIsHalfWidth(chart) ? 2 : 1;
  const verdicts: SizeVerdict[] = [];
  for (const row of chart) {
    const points: SizeVerdict["points"] = [];
    for (const key of BODY_KEYS) {
      const bodyValue = body[key];
      const garment = row.measurements[CHART_KEY[key]];
      if (bodyValue === undefined || garment === undefined) continue;
      const { ease, cm } = easeOf(garment * factor, bodyValue);
      points.push({ key, ease, cm });
    }
    if (points.length === 0) continue;
    verdicts.push({ size: row.size, overall: worst(points), points });
  }
  if (verdicts.length === 0) return { kind: "no_overlap" };
  const wanted = PREFERRED[fit ?? "tanto_faz"];
  let recommended: string | null = null;
  for (const ease of wanted) {
    // Entre os tamanhos com o mesmo veredito, o mais confortável (mais pontos "certo").
    const hits = verdicts.filter((verdict) => verdict.overall === ease);
    if (hits.length > 0) {
      recommended = hits.reduce((best, verdict) => (comfort(verdict) > comfort(best) ? verdict : best), hits[0]).size;
      break;
    }
  }
  if (!recommended) {
    // Nada no caimento preferido: o menor tamanho que não aperta.
    recommended = verdicts.find((verdict) => verdict.overall !== "aperta")?.size ?? null;
  }
  return { kind: "advice", verdicts, recommended, fit };
}

function pointLabel(point: SizeVerdict["points"][number]): string {
  return `${BODY_LABELS[point.key]} ${point.cm >= 0 ? `${point.cm} cm de folga` : `${Math.abs(point.cm)} cm a menos`}`;
}

/** "No M fica certo (busto 6 cm de folga); o P marca a cintura; eu iria de M." */
export function renderSizeAdvice(advice: SizeAdvice): string {
  if (advice.kind === "no_body") return "Me conta suas medidas (busto, cintura e quadril, em cm) e eu digo como cada tamanho fica em você.";
  if (advice.kind === "no_chart") return "Esta peça ainda não tem a tabela de medidas — na dúvida, fale com a gente.";
  if (advice.kind === "no_overlap") return "A tabela desta peça só traz comprimento — não dá para comparar com busto, cintura e quadril. Na dúvida, fale com a gente.";
  const parts = advice.verdicts.map((verdict) => {
    const detail = verdict.points.map(pointLabel).join(", ");
    if (verdict.overall === "aperta") {
      const tight = verdict.points.filter((point) => point.ease === "aperta").map((point) => BODY_WHERE[point.key]).join(" e ");
      return `o ${verdict.size} aperta ${tight}`.trim();
    }
    if (verdict.overall === "marca") {
      const marks = verdict.points.filter((point) => point.ease === "marca").map((point) => BODY_WHERE[point.key]).join(" e ");
      return `o ${verdict.size} marca ${marks}`.trim();
    }
    return `no ${verdict.size} ${EASE_LABELS[verdict.overall]} (${detail})`;
  });
  const closing = advice.recommended ? ` Eu iria de ${advice.recommended}.` : " Nenhum tamanho fecha bem — vale conversar com a gente.";
  return `${parts.join("; ")}.${closing}`.replace(/\s+\./g, ".");
}
