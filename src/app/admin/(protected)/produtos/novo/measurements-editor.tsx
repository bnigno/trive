"use client";

import { Input } from "@/components/ui/form";
import { Table, Td, Tr } from "@/components/ui/table";
import {
  MEASUREMENT_KEYS,
  MEASUREMENT_LABELS,
  measurementsSchema,
  type MeasurementKey,
} from "@/core/catalog/measurements";

/** O que a dona digitou: tamanho → medida → texto (vazio = sem medida). */
export type MeasurementsDraft = Record<string, Partial<Record<MeasurementKey, string>>>;

/**
 * Fita métrica por tamanho, em centímetros da peça deitada. As linhas saem
 * das fichas de tamanho; as cores do mesmo tamanho dividem a tabela. Vem
 * preenchida quando a foto da tabela do fornecedor entrou no rascunho — e
 * funciona sozinha, para quem prefere medir à mão.
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
  const hasInvalid = sizes.some((size) =>
    MEASUREMENT_KEYS.some((key) => {
      const raw = values[size]?.[key] ?? "";
      return raw.trim() !== "" && parseMeasurementCm(raw) === null;
    }),
  );

  if (sizes.length === 0) {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        Acrescente os tamanhos acima para preencher a fita métrica de cada um.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
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
      <div>
        <Table headers={["Tamanho", ...MEASUREMENT_KEYS.map((key) => MEASUREMENT_LABELS[key])]}>
          {sizes.map((size) => (
            <Tr key={size}>
              <Td>
                <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{size}</span>
              </Td>
              {MEASUREMENT_KEYS.map((key) => (
                <Td key={key}>
                  {(() => {
                    const raw = values[size]?.[key] ?? "";
                    const invalid = raw.trim() !== "" && parseMeasurementCm(raw) === null;
                    return (
                      <Input
                        inputMode="decimal"
                        className={
                          invalid
                            ? "w-24 border-amber-500 focus-visible:outline-amber-500"
                            : "w-24"
                        }
                        aria-label={`${MEASUREMENT_LABELS[key]} do tamanho ${size} em centímetros`}
                        aria-invalid={invalid || undefined}
                        title={
                          invalid
                            ? "Use centímetros inteiros ou meio centímetro: 88 ou 88,5."
                            : undefined
                        }
                        placeholder="—"
                        value={raw}
                        onChange={(event) => onChange(size, key, event.target.value)}
                      />
                    );
                  })()}
                </Td>
              ))}
            </Tr>
          ))}
        </Table>
      </div>
    </div>
  );
}

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
