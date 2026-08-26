"use client";

// Seletor de variação por eixo (attributesSchema) + preço + botão de compra.
// Recebe as variantes já serializadas por props do Server Component da página.
// A escolha atual vive no componente de cima (product-detail-client): a galeria
// precisa da mesma cor, e dois donos do mesmo estado sempre desandam.
import { useMemo } from "react";

import { AddToCartButton } from "@/components/store/cart/add-to-cart";
import { cx } from "@/components/ui/cx";
import { formatCentsBRL } from "@/lib/money";
import type { PublicVariant } from "@/services/store-catalog";

/**
 * Escolha inicial de cada eixo: a primeira variação com estoque, ou a primeira
 * de todas se o produto inteiro estiver esgotado.
 */
export function initialAxisSelection(
  axes: readonly string[],
  variants: readonly PublicVariant[],
): Record<string, string> {
  const initial =
    variants.find((variant) => variant.availableQty > 0) ?? variants[0];
  const selection: Record<string, string> = {};
  if (initial) {
    for (const axis of axes) {
      const value = initial.attributes[axis];
      if (value) selection[axis] = value;
    }
  }
  return selection;
}

export function VariantPicker({
  productName,
  slug,
  imageUrl,
  axes,
  variants,
  selected,
  onSelect,
}: {
  productName: string;
  slug: string;
  imageUrl?: string;
  axes: string[];
  variants: PublicVariant[];
  selected: Record<string, string>;
  onSelect: (axis: string, value: string) => void;
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
          <p className="font-store text-2xl text-ink-900">
            {formatCentsBRL(matched.priceCents)}
          </p>
          {matched.compareAtPriceCents != null &&
          matched.compareAtPriceCents > matched.priceCents ? (
            <p className="font-store text-base text-ink-400 line-through">
              {formatCentsBRL(matched.compareAtPriceCents)}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="font-store text-lg text-ink-500">
          Combinação indisponível
        </p>
      )}

      {axes.map((axis) => (
        <fieldset key={axis}>
          <legend className="mb-2.5 font-store text-eyebrow font-medium uppercase text-ink-500">
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
                  onClick={() => onSelect(axis, value)}
                  className={cx(
                    "rounded-(--radius-hair) border px-4 py-2 font-store text-sm transition-colors duration-300 ease-silk focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600",
                    isSelected
                      ? "border-ink-950 bg-ink-950 text-ivory-50"
                      : enabled
                        ? "border-ivory-400 bg-ivory-50 text-ink-700 hover:border-ink-900"
                        : "cursor-not-allowed border-ivory-300 bg-transparent text-ink-300 line-through",
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
        <p className="font-store text-sm font-medium text-ink-500">
          Esgotado — esta variação está sem estoque no momento.
        </p>
      ) : null}
      {matched && lowStock ? (
        <p className="font-store text-sm font-medium text-gold-800">
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
