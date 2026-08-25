"use client";

import Link from "next/link";
import { useActionState } from "react";

import { PriceBreakdownView } from "@/components/admin/price-breakdown";
import {
  Field,
  FormError,
  FormSuccess,
  Input,
  Select,
  SubmitButton,
} from "@/components/ui/form";
import { ROUNDING_MODE_OPTIONS } from "../labels";
import {
  previewPriceAction,
  savePriceAction,
  type CalculatorState,
} from "./actions";

export function CalculatorForm({
  variantId,
  defaults,
}: {
  variantId: string;
  defaults: { margem: string; custosFixos: string; arredondamento: string };
}) {
  const [calcState, calcAction] = useActionState<CalculatorState, FormData>(
    previewPriceAction,
    {},
  );
  const [saveState, saveAction] = useActionState<CalculatorState, FormData>(
    savePriceAction,
    {},
  );
  const preview = calcState.preview;

  return (
    <div className="flex flex-col gap-6">
      <form
        action={calcAction}
        className="grid items-end gap-4 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900 sm:grid-cols-3"
      >
        <input type="hidden" name="variantId" value={variantId} />
        <Field
          label="Margem alvo (%)"
          hint="Ex.: 30 significa 30% de margem sobre o preço."
        >
          <Input
            name="margem"
            inputMode="decimal"
            defaultValue={defaults.margem}
            required
          />
        </Field>
        <Field
          label="Custos fixos (R$)"
          hint="Embalagem, brinde etc. por unidade vendida."
        >
          <Input
            name="custosFixos"
            inputMode="decimal"
            defaultValue={defaults.custosFixos}
            placeholder="0,00"
          />
        </Field>
        <Field label="Arredondamento" hint="Como o preço final deve terminar.">
          <Select name="arredondamento" defaultValue={defaults.arredondamento}>
            {ROUNDING_MODE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
        <div className="sm:col-span-3">
          <SubmitButton pendingLabel="Calculando…">Calcular</SubmitButton>
        </div>
      </form>

      <FormError message={calcState.error} />
      <FormError message={saveState.error} />
      <FormSuccess message={saveState.success} />
      {saveState.pendente ? (
        <p className="text-sm">
          <Link
            href="/admin/precos/pendencias"
            className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
          >
            Ver pendências de aprovação →
          </Link>
        </p>
      ) : null}

      {preview ? (
        <div className="flex flex-col gap-4">
          <PriceBreakdownView breakdown={preview.breakdown} />
          {preview.willRequireApproval ? (
            <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
              Ao salvar, este preço vai para aprovação antes de valer (motivos:{" "}
              {preview.reasonsLabel}).
            </p>
          ) : (
            <p className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
              Ao salvar, este preço entra em vigor imediatamente.
            </p>
          )}
          <form action={saveAction}>
            <input type="hidden" name="variantId" value={variantId} />
            <input type="hidden" name="modo" value="politica" />
            <input type="hidden" name="margem" value={preview.values.margem} />
            <input
              type="hidden"
              name="custosFixos"
              value={preview.values.custosFixos}
            />
            <input
              type="hidden"
              name="arredondamento"
              value={preview.values.arredondamento}
            />
            <SubmitButton pendingLabel="Salvando…">
              Salvar este preço
            </SubmitButton>
          </form>
        </div>
      ) : null}

      <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          Definir preço na mão
        </h2>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
          Digite o preço final desejado; a margem resultante é calculada e as
          regras de aprovação continuam valendo.
        </p>
        <form
          action={saveAction}
          className="mt-4 flex max-w-sm items-end gap-2"
        >
          <input type="hidden" name="variantId" value={variantId} />
          <input type="hidden" name="modo" value="manual" />
          <Field label="Preço (R$)" className="flex-1">
            <Input
              name="preco"
              inputMode="decimal"
              placeholder="149,90"
              required
            />
          </Field>
          <SubmitButton variant="outline" pendingLabel="Salvando…">
            Salvar preço manual
          </SubmitButton>
        </form>
      </div>
    </div>
  );
}
