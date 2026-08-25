"use client";

import { useActionState, useState } from "react";
import { Card } from "@/components/ui/card";
import {
  Button,
  Field,
  FormError,
  Input,
  Select,
  SubmitButton,
  TextArea,
} from "@/components/ui/form";
import { createProductAction, type FormState } from "./actions";

export type CategoryOption = { id: string; name: string };

type VariantRow = {
  key: number;
  sku: string;
  cost: string;
  attributes: Record<string, string>;
};

const initialState: FormState = {};

function parseAxes(text: string): string[] {
  const seen = new Set<string>();
  const axes: string[] = [];
  for (const raw of text.split(",")) {
    const axis = raw.trim();
    const lowered = axis.toLowerCase();
    if (axis && !seen.has(lowered)) {
      seen.add(lowered);
      axes.push(axis);
    }
  }
  return axes;
}

export function NewProductForm({
  categoryOptions,
}: {
  categoryOptions: CategoryOption[];
}) {
  const [state, formAction] = useActionState(createProductAction, initialState);
  const [axesText, setAxesText] = useState("");
  const [nextKey, setNextKey] = useState(2);
  const [rows, setRows] = useState<VariantRow[]>([
    { key: 1, sku: "", cost: "", attributes: {} },
  ]);

  const axes = parseAxes(axesText);
  const hasAxes = axes.length > 0;
  const visibleRows = hasAxes ? rows : rows.slice(0, 1);

  const variantsJson = JSON.stringify(
    visibleRows.map((row) => ({
      sku: row.sku,
      cost: row.cost,
      attributes: hasAxes
        ? Object.fromEntries(axes.map((axis) => [axis, row.attributes[axis] ?? ""]))
        : {},
    })),
  );

  function updateRow(key: number, patch: Partial<Omit<VariantRow, "key">>) {
    setRows((current) =>
      current.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    );
  }

  function updateRowAttribute(key: number, axis: string, value: string) {
    setRows((current) =>
      current.map((row) =>
        row.key === key
          ? { ...row, attributes: { ...row.attributes, [axis]: value } }
          : row,
      ),
    );
  }

  function addRow() {
    setRows((current) => [
      ...current,
      { key: nextKey, sku: "", cost: "", attributes: {} },
    ]);
    setNextKey((key) => key + 1);
  }

  function removeRow(key: number) {
    setRows((current) =>
      current.length > 1 ? current.filter((row) => row.key !== key) : current,
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <input type="hidden" name="variantsJson" value={variantsJson} />

      <Card title="Dados do produto">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nome" className="sm:col-span-2">
            <Input name="name" required placeholder="Ex.: Camiseta básica" />
          </Field>
          <Field label="Descrição" className="sm:col-span-2">
            <TextArea
              name="description"
              placeholder="Descreva o produto para você e seus clientes (opcional)"
            />
          </Field>
          <Field label="Marca">
            <Input name="brand" placeholder="Ex.: TRIVË (opcional)" />
          </Field>
          <Field label="Categoria">
            <Select name="categoryId" defaultValue="">
              <option value="">Sem categoria</option>
              {categoryOptions.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Card>

      <Card title="Variações">
        <div className="flex flex-col gap-4">
          <Field
            label="Eixos de variação"
            hint='Em que o produto varia? Separe por vírgula, ex.: "cor, tamanho". Deixe vazio se o produto não tem variações.'
          >
            <Input
              name="axes"
              value={axesText}
              onChange={(event) => setAxesText(event.target.value)}
              placeholder="cor, tamanho"
            />
          </Field>

          {!hasAxes ? (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Produto sem variações: informe só o SKU (código único do produto)
              e o custo.
            </p>
          ) : null}

          <div className="flex flex-col gap-3">
            {visibleRows.map((row, index) => (
              <div
                key={row.key}
                className="flex flex-wrap items-end gap-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-800"
              >
                {axes.map((axis) => (
                  <Field
                    key={axis}
                    label={axis}
                    className="min-w-32 flex-1"
                  >
                    <Input
                      value={row.attributes[axis] ?? ""}
                      onChange={(event) =>
                        updateRowAttribute(row.key, axis, event.target.value)
                      }
                      placeholder={`Ex.: ${axis === "cor" ? "Preto" : axis === "tamanho" ? "M" : "…"}`}
                    />
                  </Field>
                ))}
                <Field label="SKU" className="min-w-36 flex-1">
                  <Input
                    value={row.sku}
                    onChange={(event) =>
                      updateRow(row.key, { sku: event.target.value })
                    }
                    placeholder={`Ex.: CAM-00${index + 1}`}
                  />
                </Field>
                <Field label="Custo inicial (R$)" className="min-w-32 flex-1">
                  <Input
                    value={row.cost}
                    onChange={(event) =>
                      updateRow(row.key, { cost: event.target.value })
                    }
                    inputMode="decimal"
                    placeholder="1.234,56"
                  />
                </Field>
                {hasAxes ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mb-1"
                    onClick={() => removeRow(row.key)}
                    disabled={visibleRows.length <= 1}
                  >
                    Remover
                  </Button>
                ) : null}
              </div>
            ))}
          </div>

          {hasAxes ? (
            <div>
              <Button variant="outline" size="sm" onClick={addRow}>
                Adicionar variação
              </Button>
            </div>
          ) : null}
        </div>
      </Card>

      <FormError message={state.error} />

      <div className="flex items-center gap-3">
        <SubmitButton pendingLabel="Criando…">Criar produto</SubmitButton>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Depois de criar, você define o preço de venda na calculadora de
          preços.
        </p>
      </div>
    </form>
  );
}
