"use client";

import { memo, useState } from "react";
import { Button, Field, Input } from "@/components/ui/form";
import { Table, Td, Tr } from "@/components/ui/table";
import {
  MAX_GRID_ROWS,
  type GridCombination,
  type VariantGrid,
} from "@/core/catalog/variant-grid";

/** O que o dono digitou numa linha. `sku` ausente = a sugestão vale. */
export type GridCell = { sku?: string; quantity: string; cost: string };

export const EMPTY_CELL: GridCell = { quantity: "", cost: "" };

export function VariantGridEditor({
  grid,
  cells,
  onCellChange,
  onFillAll,
  selectedCount,
}: {
  grid: VariantGrid;
  cells: Record<string, GridCell>;
  onCellChange: (key: string, patch: Partial<GridCell>) => void;
  onFillAll: (patch: { quantity?: string; cost?: string }) => void;
  selectedCount: number;
}) {
  const [bulkQuantity, setBulkQuantity] = useState("");
  const [bulkCost, setBulkCost] = useState("");

  const hasAxes = grid.axes.length > 0;
  const total = grid.combinations.length;
  const overLimit = total > MAX_GRID_ROWS;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Preço de venda (R$)"
          hint="Vale para todas as combinações. Dá para ajustar depois, uma a uma, na calculadora de preços."
        >
          <Input name="price" inputMode="decimal" placeholder="129,90" />
        </Field>
      </div>

      {overLimit ? (
        <p
          role="alert"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm leading-relaxed text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
        >
          As cores e os tamanhos que você escolheu dão {total} combinações —
          mais do que esta tela consegue mostrar de uma vez (o limite é{" "}
          {MAX_GRID_ROWS}). Tire algumas fichas, cadastre o que couber e
          acrescente o resto depois, na tela do produto.
        </p>
      ) : (
        <>
          <p className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs leading-relaxed text-zinc-600 dark:border-zinc-800 dark:bg-zinc-800/40 dark:text-zinc-300">
            {hasAxes ? (
              <>
                <strong className="font-semibold">
                  Deixe a quantidade em branco quando a combinação não existir.
                </strong>{" "}
                É assim que você diz, por exemplo, que o verde só veio em P e G.
                Quantidade <strong className="font-semibold">0</strong> é
                diferente: cria a variação, só que sem estoque hoje.
              </>
            ) : (
              <>
                Sem cores e sem tamanhos, este é um produto único. Preencha a
                quantidade que você tem em mãos — pode ser{" "}
                <strong className="font-semibold">0</strong>.
              </>
            )}
          </p>

          {hasAxes ? (
            <div className="flex flex-wrap items-end gap-3 rounded-md border border-dashed border-zinc-300 p-3 dark:border-zinc-700">
              <p className="w-full text-xs font-medium text-zinc-600 dark:text-zinc-400">
                Preenchimento rápido
              </p>
              <Field label="Quantidade" className="w-28">
                <Input
                  value={bulkQuantity}
                  onChange={(event) => setBulkQuantity(event.target.value)}
                  inputMode="numeric"
                  placeholder="5"
                />
              </Field>
              <Field label="Custo (R$)" className="w-32">
                <Input
                  value={bulkCost}
                  onChange={(event) => setBulkCost(event.target.value)}
                  inputMode="decimal"
                  placeholder="49,90"
                />
              </Field>
              <Button
                variant="outline"
                size="sm"
                className="mb-1"
                disabled={bulkQuantity.trim() === "" && bulkCost.trim() === ""}
                onClick={() =>
                  onFillAll({
                    // Campo em branco não apaga o que já está na grade:
                    // limpar todas as quantidades de uma vez seria apagar
                    // todas as variações sem querer.
                    ...(bulkQuantity.trim() === ""
                      ? {}
                      : { quantity: bulkQuantity }),
                    ...(bulkCost.trim() === "" ? {} : { cost: bulkCost }),
                  })
                }
              >
                Aplicar a todas
              </Button>
            </div>
          ) : null}

          <Table
            headers={[
              ...(hasAxes ? ["Combinação"] : []),
              "Código (SKU)",
              "Quantidade",
              "Custo (R$)",
            ]}
          >
            {grid.combinations.map((combination) => (
              <GridRowEditor
                key={combination.key}
                combination={combination}
                cell={cells[combination.key]}
                hasAxes={hasAxes}
                onCellChange={onCellChange}
              />
            ))}
          </Table>

          <p
            role="status"
            className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
          >
            {selectedCount === 0
              ? "Nenhuma variação será criada ainda — preencha a quantidade das combinações que existem."
              : selectedCount === 1
                ? "1 variação será criada."
                : `${selectedCount} variações serão criadas.`}
          </p>
        </>
      )}
    </div>
  );
}

/**
 * memo porque a grade chega a 60 linhas: sem isso cada tecla digitada numa
 * linha redesenharia os campos de todas as outras.
 */
const GridRowEditor = memo(function GridRowEditor({
  combination,
  cell,
  hasAxes,
  onCellChange,
}: {
  combination: GridCombination;
  cell: GridCell | undefined;
  hasAxes: boolean;
  onCellChange: (key: string, patch: Partial<GridCell>) => void;
}) {
  const current = cell ?? EMPTY_CELL;
  const filled = current.quantity.trim() !== "";
  const what = combination.label || "produto";

  return (
    <Tr className={filled ? undefined : "opacity-60"}>
      {hasAxes ? (
        <Td className="whitespace-nowrap font-medium text-zinc-900 dark:text-zinc-100">
          {combination.label}
        </Td>
      ) : null}
      <Td className="min-w-48">
        <Input
          value={current.sku ?? combination.sku}
          onChange={(event) =>
            onCellChange(combination.key, { sku: event.target.value })
          }
          aria-label={`Código (SKU) de ${what}`}
        />
      </Td>
      <Td className="w-28">
        <Input
          value={current.quantity}
          onChange={(event) =>
            onCellChange(combination.key, { quantity: event.target.value })
          }
          inputMode="numeric"
          placeholder="não veio"
          aria-label={`Quantidade de ${what}`}
        />
      </Td>
      <Td className="w-32">
        <Input
          value={current.cost}
          onChange={(event) =>
            onCellChange(combination.key, { cost: event.target.value })
          }
          inputMode="decimal"
          placeholder="opcional"
          aria-label={`Custo de ${what}`}
        />
      </Td>
    </Tr>
  );
});
