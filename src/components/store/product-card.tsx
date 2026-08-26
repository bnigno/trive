// Card de produto da vitrine: foto dominante, nome, preço e disponibilidade.
// Server Component puro — sem interatividade; o clique navega para o PDP.
import Link from "next/link";

import { Monogram } from "@/components/store/brand/monogram";
import { eyebrow } from "@/components/store/styles";
import { cx } from "@/components/ui/cx";
import { formatCentsBRL } from "@/lib/money";
import {
  publicThumbUrl,
  type PublicProductListItem,
} from "@/services/store-catalog";

export function ProductCard({ product }: { product: PublicProductListItem }) {
  const soldOut = !product.available;
  const hasRange = product.priceFromCents !== product.priceToCents;

  return (
    <Link
      href={`/produto/${product.slug}`}
      className={cx(
        "group flex h-full flex-col overflow-hidden rounded-(--radius-hair) border border-ivory-300 bg-ivory-50 transition-colors duration-300 ease-silk hover:border-gold-500/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600",
        soldOut && "opacity-60",
      )}
    >
      <div className="relative aspect-square w-full overflow-hidden bg-ivory-200">
        {product.imagePath ? (
          // <img> simples de propósito: o otimizador de imagens da Vercel tem
          // limites no plano gratuito — servimos o thumb .webp direto do Storage.
          <img
            src={publicThumbUrl(product.imagePath)}
            alt={product.name}
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-700 ease-silk group-hover:scale-[1.04]"
          />
        ) : (
          <div
            aria-hidden="true"
            className="flex h-full w-full items-center justify-center"
          >
            <Monogram size={56} className="opacity-15" />
          </div>
        )}
        {soldOut ? (
          <span className="absolute left-3 top-3 rounded-(--radius-hair) border border-ivory-300 bg-ivory-50/90 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.2em] text-ink-500">
            Esgotado
          </span>
        ) : null}
      </div>
      <div className="flex flex-1 flex-col gap-1 px-4 py-3">
        {product.brand ? <p className={eyebrow}>{product.brand}</p> : null}
        <h3 className="font-store text-sm font-medium leading-snug text-ink-900 decoration-gold-500 decoration-1 underline-offset-4 group-hover:underline">
          {product.name}
        </h3>
        <p className="mt-auto pt-1 font-store text-base font-medium text-ink-900">
          {hasRange ? (
            <>
              <span className="text-xs font-normal text-ink-400">
                a partir de{" "}
              </span>
              {formatCentsBRL(product.priceFromCents)}
            </>
          ) : (
            formatCentsBRL(product.priceFromCents)
          )}
        </p>
      </div>
    </Link>
  );
}
