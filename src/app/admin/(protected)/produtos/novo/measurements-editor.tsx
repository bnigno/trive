"use client";

import { Input } from "@/components/ui/form";
import { Table, Td, Tr } from "@/components/ui/table";
import {
  MEASUREMENT_KEYS,
  MEASUREMENT_LABELS,
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
                  <Input
                    inputMode="decimal"
                    className="w-24"
                    aria-label={`${MEASUREMENT_LABELS[key]} do tamanho ${size} em centímetros`}
                    placeholder="—"
                    value={values[size]?.[key] ?? ""}
                    onChange={(event) => onChange(size, key, event.target.value)}
                  />
                </Td>
              ))}
            </Tr>
          ))}
        </Table>
      </div>
    </div>
  );
}
