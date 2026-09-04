// Card de produto da vitrine: foto dominante, nome, preço e disponibilidade.
// Server Component puro — sem interatividade; o clique navega para o PDP.
// Sem foto, mostra a "etiqueta de ateliê": fita + inicial da peça em serif.
import Link from "next/link";

import { Ribbon } from "@/components/store/ribbon";
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
      <div className="relative aspect-(--aspect-product) w-full overflow-hidden bg-ivory-150">
        {product.imagePath ? (
          // <img> simples de propósito: o otimizador de imagens da Vercel tem
          // limites no plano atual — servimos o thumb .webp direto do Storage.
          // width/height reservam a caixa antes do download (CLS zero).
          <img
            src={publicThumbUrl(product.imagePath)}
            alt={product.name}
            width={400}
            height={500}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover transition-transform duration-700 ease-silk group-hover:scale-[1.04]"
          />
        ) : (
          <div
            aria-hidden="true"
            className="relative flex h-full w-full items-center justify-center"
          >
            <Ribbon
              variant="static"
              size="md"
              className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 opacity-25"
            />
            <span className="relative font-display text-[6rem] leading-none font-semibold text-ivory-400 select-none">
              {product.name.trim().charAt(0).toUpperCase()}
            </span>
          </div>
        )}
        {soldOut ? (
          <span className="absolute top-3 left-3 rounded-(--radius-hair) border border-ivory-300 bg-ivory-50/90 px-2.5 py-1 font-store text-[10px] font-medium tracking-[0.2em] text-ink-500 uppercase">
            Esgotado
          </span>
        ) : null}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 px-4 py-3">
        {product.brand ? <p className={eyebrow}>{product.brand}</p> : null}
        <h3 className="relative font-store text-[15px] leading-snug font-medium text-ink-900">
          {product.name}
          {/* Fita que se desenha no hover, sem ocupar espaço no fluxo. */}
          <Ribbon
            variant="hover"
            size="sm"
            className="absolute -bottom-2.5 left-0 h-2 w-16"
          />
        </h3>
        <p className="mt-auto pt-1.5 font-store text-base font-medium text-ink-900 tabular-nums">
          {hasRange ? (
            <>
              <span className="text-xs font-normal text-ink-500">
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
