// Card de produto da vitrine: foto dominante, nome, preço e disponibilidade.
// Server Component puro — sem interatividade; o clique navega para o PDP.
import Link from "next/link";

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
        "group flex flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 dark:border-zinc-800 dark:bg-zinc-900",
        soldOut && "opacity-60",
      )}
    >
      <div className="relative aspect-square w-full overflow-hidden bg-zinc-100 dark:bg-zinc-800">
        {product.imagePath ? (
          // <img> simples de propósito: o otimizador de imagens da Vercel tem
          // limites no plano gratuito — servimos o thumb .webp direto do Storage.
          <img
            src={publicThumbUrl(product.imagePath)}
            alt={product.name}
            loading="lazy"
            className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]"
          />
        ) : (
          <div
            aria-hidden="true"
            className="flex h-full w-full items-center justify-center text-4xl text-zinc-300 dark:text-zinc-600"
          >
            ✦
          </div>
        )}
        {soldOut ? (
          <span className="absolute left-3 top-3 rounded-full bg-zinc-900/80 px-2.5 py-1 text-xs font-medium text-white">
            Esgotado
          </span>
        ) : null}
      </div>
      <div className="flex flex-1 flex-col gap-1 px-4 py-3">
        {product.brand ? (
          <p className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            {product.brand}
          </p>
        ) : null}
        <h3 className="text-sm font-medium leading-snug text-zinc-900 dark:text-zinc-100">
          {product.name}
        </h3>
        <p className="mt-auto pt-1 text-base font-semibold text-amber-800 dark:text-amber-400">
          {hasRange ? (
            <>
              <span className="text-xs font-normal text-zinc-500 dark:text-zinc-400">
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
