"use client";

// Barra fixa de compra do celular: aparece quando o botão principal sai por
// cima da tela (o pai observa um marcador) e traz preço, variação e o MESMO
// AddToCartButton (mesmo item, mesmo carrinho). Oculta = inert + fora da tela.
import { AddToCartButton } from "@/components/store/cart/add-to-cart";
import { cx } from "@/components/ui/cx";
import { formatCentsBRL } from "@/lib/money";
import type { PublicVariant } from "@/services/store-catalog";

export function BuyBar({
  visible,
  productName,
  slug,
  imageUrl,
  matched,
  attributesLabel,
}: {
  visible: boolean;
  productName: string;
  slug: string;
  imageUrl?: string;
  matched: PublicVariant | undefined;
  attributesLabel?: string;
}) {
  if (!matched) return null;
  const soldOut = matched.availableQty <= 0;

  return (
    <div
      inert={!visible}
      aria-hidden={!visible}
      className={cx(
        "fixed inset-x-0 bottom-0 z-30 border-t border-gold-500/40 bg-ivory-50 transition-transform duration-300 ease-silk lg:hidden",
        visible ? "translate-y-0" : "translate-y-full",
      )}
      style={{
        paddingBottom: "env(safe-area-inset-bottom)",
        paddingLeft: "max(1rem, env(safe-area-inset-left))",
        paddingRight: "max(1rem, env(safe-area-inset-right))",
      }}
    >
      <div className="flex items-center gap-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate font-store text-xs text-ink-500">
            {attributesLabel ?? productName}
          </p>
          <p className="font-store text-lg font-medium text-ink-900 tabular-nums">
            {formatCentsBRL(matched.priceCents)}
          </p>
        </div>
        <AddToCartButton
          compact
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
      </div>
    </div>
  );
}
