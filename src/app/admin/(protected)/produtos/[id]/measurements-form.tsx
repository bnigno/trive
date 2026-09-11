"use client";

import { useActionState } from "react";
import {
  MEASUREMENT_KEYS,
  MEASUREMENT_LABELS,
  type SizeChartRow,
} from "@/core/catalog/measurements";
import { FormError, FormSuccess, Input, SubmitButton } from "@/components/ui/form";
import { setProductMeasurementsAction, type FormState } from "./actions";

const initialState: FormState = {};

/**
 * Fita métrica: uma linha por tamanho, seis medidas em cm. As cores do mesmo
 * tamanho compartilham a tabela; campo vazio = sem medida.
 */
export function MeasurementsForm({
  productId,
  sizes,
  chart,
}: {
  productId: string;
  sizes: string[];
  chart: SizeChartRow[];
}) {
  const [state, formAction] = useActionState(setProductMeasurementsAction, initialState);
  const bySize = new Map(chart.map((row) => [row.size.toLowerCase(), row.measurements]));

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="sizes" value={sizes.join("\n")} />
      <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              <th className="px-3 py-2 text-left font-medium">Tamanho</th>
              {MEASUREMENT_KEYS.map((key) => (
                <th key={key} className="px-2 py-2 text-left font-medium">
                  {MEASUREMENT_LABELS[key]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sizes.map((size) => {
              const current = bySize.get(size.toLowerCase());
              return (
                <tr key={size} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
                  <td className="px-3 py-2 font-medium text-zinc-900 dark:text-zinc-100">{size}</td>
                  {MEASUREMENT_KEYS.map((key) => (
                    <td key={key} className="px-2 py-1.5">
                      <Input
                        name={`m:${size}:${key}`}
                        type="number"
                        inputMode="decimal"
                        min={1}
                        max={300}
                        step={0.5}
                        defaultValue={current?.[key] ?? ""}
                        placeholder="cm"
                        aria-label={`${MEASUREMENT_LABELS[key]} do tamanho ${size}`}
                        className="w-20"
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Medidas da peça deitada, em centímetros. As cores do mesmo tamanho compartilham a
        tabela; deixe em branco o que não se aplica.
      </p>
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      <div>
        <SubmitButton pendingLabel="Salvando…" size="sm">
          Salvar fita métrica
        </SubmitButton>
      </div>
    </form>
  );
}
