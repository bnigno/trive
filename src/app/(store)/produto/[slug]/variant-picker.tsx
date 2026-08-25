"use client";

// Seletor de variação por eixo (attributesSchema) + preço + botão de compra.
// Recebe as variantes já serializadas por props do Server Component da página.
import { useMemo, useState } from "react";

import { AddToCartButton } from "@/components/store/cart/add-to-cart";
import { cx } from "@/components/ui/cx";
import { formatCentsBRL } from "@/lib/money";
import type { PublicVariant } from "@/services/store-catalog";

export function VariantPicker({
  productName,
  slug,
  imageUrl,
  axes,
  variants,
}: {
  productName: string;
  slug: string;
  imageUrl?: string;
  axes: string[];
  variants: PublicVariant[];
}) {
  // Valores únicos por eixo, na ordem em que aparecem nas variantes.
  const valuesByAxis = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const axis of axes) {
      const values: string[] = [];
      for (const variant of variants) {
        const value = variant.attributes[axis];
        if (value && !values.includes(value)) values.push(value);
      }
      map.set(axis, values);
    }
    return map;
  }, [axes, variants]);

  const [selected, setSelected] = useState<Record<string, string>>(() => {
    const initial = variants.find((v) => v.availableQty > 0) ?? variants[0];
    const state: Record<string, string> = {};
    if (initial) {
      for (const axis of axes) {
        const value = initial.attributes[axis];
        if (value) state[axis] = value;
      }
    }
    return state;
  });

  const matched = useMemo(
    () =>
      variants.find((variant) =>
        axes.every((axis) => variant.attributes[axis] === selected[axis]),
      ) ?? (axes.length === 0 ? variants[0] : undefined),
    [axes, selected, variants],
  );

  // Um valor é escolhível se existe variante COM ESTOQUE que o combine com os
  // demais eixos já selecionados.
  function isValueEnabled(axis: string, value: string): boolean {
    return variants.some(
      (variant) =>
        variant.attributes[axis] === value &&
        variant.availableQty > 0 &&
        axes.every(
          (other) =>
            other === axis ||
            !selected[other] ||
            variant.attributes[other] === selected[other],
        ),
    );
  }

  const soldOut = matched ? matched.availableQty <= 0 : false;
  const lowStock = matched && matched.availableQty > 0 && matched.availableQty <= 3;
  const attributesLabel =
    axes.length > 0
      ? axes
          .map((axis) => selected[axis])
          .filter(Boolean)
          .join(" · ")
      : undefined;

  return (
    <div className="flex flex-col gap-5">
      {matched ? (
        <div className="flex items-baseline gap-3">
          <p className="text-3xl font-semibold text-amber-800 dark:text-amber-400">
            {formatCentsBRL(matched.priceCents)}
          </p>
          {matched.compareAtPriceCents != null &&
          matched.compareAtPriceCents > matched.priceCents ? (
            <p className="text-lg text-zinc-400 line-through dark:text-zinc-500">
              {formatCentsBRL(matched.compareAtPriceCents)}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-lg text-zinc-500 dark:text-zinc-400">
          Combinação indisponível
        </p>
      )}

      {axes.map((axis) => (
        <fieldset key={axis}>
          <legend className="mb-2 text-sm font-medium capitalize text-zinc-700 dark:text-zinc-300">
            {axis}
          </legend>
          <div className="flex flex-wrap gap-2">
            {(valuesByAxis.get(axis) ?? []).map((value) => {
              const isSelected = selected[axis] === value;
              const enabled = isValueEnabled(axis, value);
              return (
                <button
                  key={value}
                  type="button"
                  disabled={!enabled && !isSelected}
                  aria-pressed={isSelected}
                  onClick={() =>
                    setSelected((prev) => ({ ...prev, [axis]: value }))
                  }
                  className={cx(
                    "rounded-full border px-4 py-1.5 text-sm transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700",
                    isSelected
                      ? "border-amber-700 bg-amber-700 text-white"
                      : enabled
                        ? "border-zinc-300 bg-white text-zinc-700 hover:border-amber-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
                        : "cursor-not-allowed border-zinc-200 bg-zinc-50 text-zinc-300 line-through dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-600",
                  )}
                >
                  {value}
                </button>
              );
            })}
          </div>
        </fieldset>
      ))}

      {matched && soldOut ? (
        <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
          Esgotado — esta variação está sem estoque no momento.
        </p>
      ) : null}
      {matched && lowStock ? (
        <p className="text-sm font-medium text-amber-800 dark:text-amber-400">
          {matched.availableQty === 1
            ? "Última unidade!"
            : `Últimas ${matched.availableQty} unidades!`}
        </p>
      ) : null}

      {matched ? (
        <AddToCartButton
          item={{
            variantId: matched.variantId,
            name: productName,
            sku: matched.sku,
            slug,
            attributesLabel,
            priceCents: matched.priceCents,
            imageUrl,
            availableQty: matched.availableQty,
          }}
          disabled={soldOut}
        />
      ) : null}
    </div>
  );
}
