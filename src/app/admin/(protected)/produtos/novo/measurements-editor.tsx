"use client";

import { Field, Input } from "@/components/ui/form";
import {
  MEASUREMENT_KEYS,
  MEASUREMENT_LABELS,
  measurementsSchema,
  type MeasurementKey,
} from "@/core/catalog/measurements";

/** O que a dona digitou: tamanho → medida → texto (vazio = sem medida). */
export type MeasurementsDraft = Record<string, Partial<Record<MeasurementKey, string>>>;

/**
 * "88,5" → 88.5; vazio, texto ou valor impossível → null. A fita mede em
 * centímetros inteiros ou meio centímetro (é o que o core aceita).
 */
export function parseMeasurementCm(raw: string | undefined): number | null {
  const clean = (raw ?? "").trim().replace(",", ".");
  if (clean === "") return null;
  const value = Number(clean);
  if (!Number.isFinite(value)) return null;
  return measurementsSchema.safeParse({ bust: value }).success ? value : null;
}

/**
 * Fita métrica por tamanho, em centímetros da peça deitada. UM BLOCO POR
 * TAMANHO (e não uma tabela larga): no celular a dona preenche em pé, com a
 * peça na mão, sem rolar para o lado e sem perder de vista qual tamanho está
 * medindo. As cores do mesmo tamanho dividem a tabela; vem preenchido quando
 * a foto da tabela do fornecedor entrou no rascunho.
 */
export function MeasurementsEditor({
  sizes,
  values,
  fromPhoto,
  onChange,
}: {
  sizes: string[];
  values: MeasurementsDraft;
  /** Veio da foto da tabela: mostra o selo "transcrito da foto". */
  fromPhoto: boolean;
  onChange: (size: string, key: MeasurementKey, value: string) => void;
}) {
  if (sizes.length === 0) {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        Acrescente os tamanhos acima para preencher a fita métrica de cada um.
      </p>
    );
  }

  const invalidOf = (size: string, key: MeasurementKey): boolean => {
    const raw = values[size]?.[key] ?? "";
    return raw.trim() !== "" && parseMeasurementCm(raw) === null;
  };
  const hasInvalid = sizes.some((size) => MEASUREMENT_KEYS.some((key) => invalidOf(size, key)));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Medidas da peça deitada, em centímetros. Deixe em branco o que você não mediu.
        </p>
        {hasInvalid ? (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-100">
            um valor não entendi — use 88 ou 88,5
          </span>
        ) : null}
        {fromPhoto ? (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-100">
            transcrito da foto — confira
          </span>
        ) : null}
      </div>

      <div className="flex flex-col gap-3">
        {sizes.map((size) => (
          <div
            key={size}
            className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800"
          >
            <p className="mb-2 text-sm font-semibold text-zinc-800 dark:text-zinc-200">
              Tamanho {size}
            </p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {MEASUREMENT_KEYS.map((key) => {
                const raw = values[size]?.[key] ?? "";
                const invalid = invalidOf(size, key);
                return (
                  <Field
                    key={key}
                    label={MEASUREMENT_LABELS[key]}
                    error={invalid ? "Use 88 ou 88,5." : undefined}
                  >
                    <Input
                      inputMode="decimal"
                      aria-invalid={invalid || undefined}
                      placeholder="—"
                      value={raw}
                      onChange={(event) => onChange(size, key, event.target.value)}
                    />
                  </Field>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
