// Totais da nota (Subtotal / Desconto / Entrega / Total) como <dl>. Preços
// sempre em ink-900; o Total em Cormorant. Sem hooks: a sacola (cliente) e o
// pedido (servidor) usam o mesmo componente.
import type { ReactNode } from "react";

import { cx } from "@/components/ui/cx";
import { formatCentsBRL } from "@/lib/money";

function Row({
  label,
  extra,
  children,
}: {
  label: string;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="flex items-baseline gap-3 text-ink-700">
        {label}
        {extra}
      </dt>
      <dd className="text-ink-900 tabular-nums">{children}</dd>
    </div>
  );
}

export function TotalsList({
  subtotalCents,
  discountCents = 0,
  discountLabel = "Desconto",
  onRemoveDiscount,
  shippingCents,
  shippingFallback = "—",
  totalCents,
  className,
}: {
  subtotalCents: number;
  discountCents?: number;
  discountLabel?: string;
  /** Quando existe, aparece "remover" ao lado do desconto (cupom). */
  onRemoveDiscount?: () => void;
  /** null = entrega ainda não cotada (mostra o fallback). */
  shippingCents: number | null;
  shippingFallback?: string;
  totalCents: number;
  className?: string;
}) {
  return (
    <dl className={cx("space-y-2 font-store text-sm", className)}>
      <Row label="Subtotal">{formatCentsBRL(subtotalCents)}</Row>
      {discountCents > 0 ? (
        <Row
          label={discountLabel}
          extra={
            onRemoveDiscount ? (
              <button
                type="button"
                onClick={onRemoveDiscount}
                className="inline-flex min-h-11 items-center font-store text-xs tracking-[0.12em] text-ink-500 uppercase underline decoration-ink-300 underline-offset-4 transition-colors hover:text-claret-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600"
              >
                remover
              </button>
            ) : null
          }
        >
          − {formatCentsBRL(discountCents)}
        </Row>
      ) : null}
      <Row label="Entrega">
        {shippingCents === null
          ? shippingFallback
          : shippingCents === 0
            ? "Grátis"
            : formatCentsBRL(shippingCents)}
      </Row>
      <div className="flex items-baseline justify-between gap-4 border-t border-ivory-300 pt-3">
        <dt className="font-store text-xs font-medium tracking-[0.16em] text-ink-900 uppercase">
          Total
        </dt>
        <dd className="font-display text-2xl font-semibold text-ink-900 tabular-nums">
          {formatCentsBRL(totalCents)}
        </dd>
      </div>
    </dl>
  );
}
