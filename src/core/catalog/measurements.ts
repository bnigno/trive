// Medidas da peça (fita métrica) — PURO. Cada variação pode ter medidas em
// centímetros, da peça deitada; as cores do mesmo tamanho compartilham a
// tabela. Daqui saem a tabela da vitrine, o texto para a Lia e, mais tarde,
// o "vai me servir?" da cartela.
import { z } from "zod";

import { compareSizeLabels, findSizeAxis } from "./sizes";

export const MEASUREMENT_KEYS = [
  "bust",
  "waist",
  "hip",
  "length",
  "sleeve",
  "shoulder",
] as const;

export type MeasurementKey = (typeof MEASUREMENT_KEYS)[number];

export const MEASUREMENT_LABELS: Record<MeasurementKey, string> = {
  bust: "Busto",
  waist: "Cintura",
  hip: "Quadril",
  length: "Comprimento",
  sleeve: "Manga",
  shoulder: "Ombro",
};

const cm = z
  .number()
  .min(1, "Medida em cm: mínimo 1.")
  .max(300, "Medida em cm: máximo 300.")
  .refine((value) => Number.isInteger(value * 2), "Use centímetros inteiros ou meio centímetro.");

export const measurementsSchema = z.object({
  bust: cm.optional(),
  waist: cm.optional(),
  hip: cm.optional(),
  length: cm.optional(),
  sleeve: cm.optional(),
  shoulder: cm.optional(),
});

export type Measurements = z.infer<typeof measurementsSchema>;

/** Só as chaves com valor. */
export function compactMeasurements(value: Measurements): Measurements {
  const out: Measurements = {};
  for (const key of MEASUREMENT_KEYS) {
    if (value[key] !== undefined) out[key] = value[key];
  }
  return out;
}

export function isMeasurementsEmpty(value: Measurements | null | undefined): boolean {
  return !value || MEASUREMENT_KEYS.every((key) => value[key] === undefined);
}

/** Tolerante: jsonb nulo, torto ou vazio vira null em vez de derrubar a página. */
export function parseMeasurements(raw: unknown): Measurements | null {
  const parsed = measurementsSchema.safeParse(raw ?? {});
  if (!parsed.success) return null;
  const compact = compactMeasurements(parsed.data);
  return isMeasurementsEmpty(compact) ? null : compact;
}

// A ordem de tamanhos e o eixo moram em ./sizes (sem zod); re-exportados
// aqui para quem já usa a fita métrica.
export { compareSizeLabels, findSizeAxis };

export type SizeChartRow = { size: string; measurements: Measurements };

/**
 * Uma linha por tamanho (a primeira variação com medidas daquele tamanho
 * representa as cores), ordenada. Sem eixo de tamanho: uma linha "Único".
 */
export function buildSizeChart(
  variants: readonly { attributes: Record<string, string>; measurements: Measurements | null }[],
  axes: readonly string[],
): SizeChartRow[] {
  const sizeAxis = findSizeAxis(axes);
  const rows = new Map<string, Measurements>();
  for (const variant of variants) {
    if (!variant.measurements || isMeasurementsEmpty(variant.measurements)) continue;
    const size = sizeAxis ? (variant.attributes[sizeAxis] ?? "").trim() || "Único" : "Único";
    if (!rows.has(size)) rows.set(size, compactMeasurements(variant.measurements));
  }
  return [...rows.entries()]
    .sort(([a], [b]) => compareSizeLabels(a, b))
    .map(([size, measurements]) => ({ size, measurements }));
}

export function isSizeChartEmpty(chart: readonly SizeChartRow[]): boolean {
  return chart.length === 0;
}

/** Colunas que têm ao menos um valor — a tabela não mostra coluna vazia. */
export function columnsPresent(chart: readonly SizeChartRow[]): MeasurementKey[] {
  return MEASUREMENT_KEYS.filter((key) => chart.some((row) => row.measurements[key] !== undefined));
}

function formatCm(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value).replace(".", ",");
}

/** Texto para a Lia: "P — busto 88, cintura 70, comprimento 110". [] quando vazio. */
export function renderSizeChartLines(chart: readonly SizeChartRow[]): string[] {
  if (chart.length === 0) return [];
  return [
    "Tabela de medidas da peça (cm, peça deitada):",
    ...chart.map((row) => {
      const parts = MEASUREMENT_KEYS.filter((key) => row.measurements[key] !== undefined).map(
        (key) => `${MEASUREMENT_LABELS[key].toLowerCase()} ${formatCm(row.measurements[key] as number)}`,
      );
      return `${row.size} — ${parts.join(", ")}`;
    }),
  ];
}
