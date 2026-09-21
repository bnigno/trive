"use client";

// Seletor de variação por eixo (attributesSchema) + preço + botão de compra.
// Recebe as variantes já serializadas por props do Server Component da página.
// A escolha atual e a variante casada vivem no componente de cima
// (product-detail-client): galeria, barra fixa e seletor precisam concordar.
import { useMemo, useState } from "react";

import { AddToCartButton } from "@/components/store/cart/add-to-cart";
import { cx } from "@/components/ui/cx";
import { findColorAxis } from "@/core/catalog/product-images";
import { compareSizeLabels, findSizeAxis } from "@/core/catalog/sizes";
import {
  findMatchedVariant,
  selectAxisValue,
} from "@/core/catalog/variant-selection";
import { formatCentsBRL } from "@/lib/money";
import type { PublicVariant } from "@/services/store-catalog";

import { RestockAlertForm } from "./restock-alert-form";

function Check() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5"
    >
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  );
}

export function VariantPicker({
  productName,
  slug,
  imageUrl,
  axes,
  variants,
  selected,
  matched,
  onSelect,
}: {
  productName: string;
  slug: string;
  imageUrl?: string;
  axes: string[];
  variants: PublicVariant[];
  selected: Record<string, string>;
  matched: PublicVariant | undefined;
  onSelect: (next: Record<string, string>) => void;
}) {
  const colorAxis = findColorAxis(axes);
  const sizeAxis = findSizeAxis(axes);
  // Eixo que mudou sozinho no último toque (grade esparsa): a cliente tocou
  // em "Céu", que não veio no 40, e o tamanho foi para o 38. Ela precisa saber.
  const [adjustment, setAdjustment] = useState<{
    value: string;
    axis: string;
    from: string | undefined;
    to: string;
  } | null>(null);

  // Valores únicos por eixo, na ordem em que aparecem nas variantes; tamanhos
  // na ordem da fita métrica (PP…GG, depois numéricos), não na do cadastro.
  const valuesByAxis = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const axis of axes) {
      const values: string[] = [];
      for (const variant of variants) {
        const value = variant.attributes[axis];
        if (value && !values.includes(value)) values.push(value);
      }
      map.set(axis, axis === sizeAxis ? values.sort(compareSizeLabels) : values);
    }
    return map;
  }, [axes, sizeAxis, variants]);

  // Todo chip leva a uma peça de verdade (a regra pura escolhe qual). Riscado
  // significa só "onde este toque te leva está esgotado" — e continua
  // clicável: é assim que a cliente chega ao "me avisa quando voltar".
  function leadsToStock(axis: string, value: string): boolean {
    const target = findMatchedVariant(
      axes,
      variants,
      selectAxisValue(axes, variants, selected, axis, value),
    );
    return target != null && target.availableQty > 0;
  }

  function pick(axis: string, value: string) {
    const next = selectAxisValue(axes, variants, selected, axis, value);
    const changed = axes.find((other) => other !== axis && next[other] !== selected[other]);
    setAdjustment(
      changed
        ? { value, axis: changed, from: selected[changed], to: next[changed] ?? "" }
        : null,
    );
    onSelect(next);
  }

  // Sempre verdadeiro: a combinação tocada não existe (por isso ajustou).
  // "Só veio em X" mentiria quando o valor existe em mais de uma peça.
  function adjustmentNotice(a: NonNullable<typeof adjustment>): string {
    const label = a.axis === colorAxis ? "a cor" : a.axis === sizeAxis ? "o tamanho" : a.axis;
    if (!a.from) return `Ajustamos ${label} para ${a.to}.`;
    if (a.axis === sizeAxis) return `${a.value} não veio em ${a.from} — ajustamos o tamanho para ${a.to}.`;
    if (a.axis === colorAxis) return `${a.from} não veio em ${a.value} — ajustamos a cor para ${a.to}.`;
    return `${a.value} não combina com ${a.from} — ajustamos ${label} para ${a.to}.`;
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
        <div>
          <div className="flex items-baseline gap-3">
            <p className="font-store text-2xl text-ink-900 tabular-nums">
              {formatCentsBRL(matched.priceCents)}
            </p>
            {matched.compareAtPriceCents != null &&
            matched.compareAtPriceCents > matched.priceCents ? (
              <p className="font-store text-base text-ink-500 line-through tabular-nums">
                {formatCentsBRL(matched.compareAtPriceCents)}
              </p>
            ) : null}
          </div>
          {/* O código costura PDP → sacola → pedido: a cliente reconhece a peça. */}
          <p className="mt-1.5 font-store text-eyebrow text-ink-500 uppercase tabular-nums">
            Cód. {matched.sku}
          </p>
        </div>
      ) : (
        <p className="font-store text-lg text-ink-500">
          Combinação indisponível
        </p>
      )}

      {axes.map((axis) => {
        const isColor = axis === colorAxis;
        return (
          <fieldset key={axis}>
            <legend className="mb-2.5 font-store text-eyebrow font-medium text-ink-500 uppercase">
              {axis}
            </legend>
            <div className="flex flex-wrap gap-2">
              {(valuesByAxis.get(axis) ?? []).map((value) => {
                const isSelected = selected[axis] === value;
                const inStock = leadsToStock(axis, value);
                return (
                  <button
                    key={value}
                    type="button"
                    title={inStock ? undefined : "Esgotado — toque para pedir aviso"}
                    aria-pressed={isSelected}
                    onClick={() => pick(axis, value)}
                    className={cx(
                      "inline-flex min-h-11 items-center gap-1.5 border px-4 py-2 font-store text-sm transition-colors duration-300 ease-silk focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600",
                      isColor ? "rounded-full" : "rounded-(--radius-hair)",
                      // Estado escolhido nunca só pela cor: borda 2px + check.
                      isSelected
                        ? isColor
                          ? "border-2 border-espresso-900 bg-rose-300 text-espresso-900"
                          : "border-ink-950 bg-ink-950 text-ivory-50"
                        : inStock
                          ? "border-ivory-400 bg-ivory-50 text-ink-700 hover:border-ink-900"
                          : "border-ivory-300 bg-transparent text-ink-400 line-through hover:border-ink-500",
                    )}
                  >
                    {isSelected && isColor ? <Check /> : null}
                    {value}
                  </button>
                );
              })}
            </div>
          </fieldset>
        );
      })}

      {adjustment ? (
        <p role="status" aria-live="polite" className="font-store text-[13px] text-ink-500">
          {adjustmentNotice(adjustment)}
        </p>
      ) : null}

      {matched && soldOut ? (
        <div>
          <p className="font-store text-sm font-medium text-ink-500">
            Esgotado — esta variação está sem estoque no momento.
          </p>
          <RestockAlertForm variantId={matched.variantId} />
        </div>
      ) : null}
      {matched && lowStock ? (
        <p className="font-store text-sm font-medium text-rose-700">
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
