// Uma peça na sacola: foto em retrato (ou inicial), nome em Cormorant,
// variação + código em eyebrow, "Retirar", stepper e total. Sem hooks.
import Link from "next/link";

import { QuantityStepper } from "@/components/store/cart/quantity-stepper";
import type { CartLine } from "@/components/store/cart/cart-context";
import { eyebrow } from "@/components/store/styles";
import { cx } from "@/components/ui/cx";
import { formatCentsBRL } from "@/lib/money";

function stockNote(line: CartLine): { text: string; urgent: boolean } | null {
  if (line.quantity < line.availableQty) return null;
  if (line.availableQty === 1) return { text: "Última unidade", urgent: true };
  if (line.availableQty <= 5) {
    return { text: `Últimas ${line.availableQty} unidades`, urgent: true };
  }
  return { text: `Só ${line.availableQty} em estoque.`, urgent: false };
}

export function CartLineItem({
  line,
  onRemove,
  onQuantity,
}: {
  line: CartLine;
  onRemove: () => void;
  onQuantity: (quantity: number) => void;
}) {
  const note = stockNote(line);
  const href = `/produto/${line.slug}`;
  const meta = [line.attributesLabel, `Cód. ${line.sku}`].filter(Boolean).join(" · ");

  return (
    <li className="flex gap-4 py-6 sm:gap-6">
      <Link href={href} tabIndex={-1} aria-hidden="true" className="block w-22 shrink-0 sm:w-28">
        {line.imageUrl ? (
          <img
            src={line.imageUrl}
            alt=""
            loading="lazy"
            width={112}
            height={140}
            className="aspect-(--aspect-product) w-full rounded-(--radius-hair) border border-ivory-300 object-cover"
          />
        ) : (
          <span className="flex aspect-(--aspect-product) w-full items-center justify-center rounded-(--radius-hair) border border-ivory-300 bg-ivory-150 font-display text-3xl font-semibold text-ivory-400 select-none">
            {line.name.trim().charAt(0).toUpperCase()}
          </span>
        )}
      </Link>

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Link
              href={href}
              className="line-clamp-2 font-display text-lg leading-tight font-semibold text-espresso-900 transition-colors hover:text-gold-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600"
            >
              {line.name}
            </Link>
            <p className={cx(eyebrow, "mt-1 break-words")}>{meta}</p>
          </div>
          <button
            type="button"
            onClick={onRemove}
            className="inline-flex min-h-11 shrink-0 items-center font-store text-eyebrow text-ink-500 uppercase transition-colors hover:text-claret-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600"
          >
            Retirar
            <span className="sr-only"> {line.name} da sacola</span>
          </button>
        </div>

        <div className="mt-auto flex flex-wrap items-end justify-between gap-3">
          <QuantityStepper
            value={line.quantity}
            max={line.availableQty}
            itemName={line.name}
            onDecrease={() => onQuantity(line.quantity - 1)}
            onIncrease={() => onQuantity(line.quantity + 1)}
          />
          <div className="text-right">
            <p className="font-store text-base font-medium text-ink-900 tabular-nums">
              {formatCentsBRL(line.priceCents * line.quantity)}
            </p>
            {line.quantity > 1 ? (
              <p className="font-store text-xs text-ink-500 tabular-nums">
                {formatCentsBRL(line.priceCents)} cada
              </p>
            ) : null}
          </div>
        </div>

        {note ? (
          <p
            className={cx(
              "font-store text-xs",
              note.urgent ? "font-medium text-rose-700" : "text-ink-500",
            )}
          >
            {note.text}
          </p>
        ) : null}
      </div>
    </li>
  );
}
