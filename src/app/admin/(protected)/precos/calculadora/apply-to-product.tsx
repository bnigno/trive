"use client";

import Link from "next/link";
import { useActionState } from "react";

import { ConfirmButton } from "@/components/ui/confirm-button";
import { Field, FormError, FormSuccess, Input } from "@/components/ui/form";
import { applyPriceToProductAction, type ApplyPriceState } from "../actions";

export function ApplyPriceToProduct({
  productId,
  variantCount,
  defaultPrice,
}: {
  productId: string;
  variantCount: number;
  defaultPrice: string;
}) {
  const [state, formAction] = useActionState<ApplyPriceState, FormData>(
    applyPriceToProductAction,
    {},
  );

  const confirmMessage =
    `Aplicar este preço às ${variantCount} variantes ativas do produto?\n\n` +
    "Cada variante recebe uma versão de preço própria; as que exigirem " +
    "aprovação (queda de preço, margem abaixo do mínimo ou variação acima do " +
    "limite) só passam a valer depois que você aprovar.";

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
        Aplicar o mesmo preço a todo o produto
      </h2>
      <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
        Este produto tem {variantCount} variantes ativas. Digite o preço uma vez
        e ele vale para todas — sem repetir a calculadora variante por variante.
      </p>
      <form action={formAction} className="mt-4 flex max-w-sm items-end gap-2">
        <input type="hidden" name="productId" value={productId} />
        <Field label="Preço (R$)" className="flex-1">
          <Input
            name="preco"
            inputMode="decimal"
            defaultValue={defaultPrice}
            placeholder="149,90"
            required
          />
        </Field>
        <ConfirmButton confirmMessage={confirmMessage} variant="outline">
          Aplicar a todas
        </ConfirmButton>
      </form>

      <div className="mt-3 flex flex-col gap-2">
        <FormError message={state.error} />
        <FormSuccess message={state.success} />
        {state.success ? (
          <p className="text-sm">
            <Link
              href="/admin/precos/pendencias"
              className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
            >
              Ver pendências de aprovação →
            </Link>
          </p>
        ) : null}
      </div>
    </div>
  );
}
