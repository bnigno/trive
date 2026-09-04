// Card de produto da vitrine: foto dominante em retrato, nome, preço e
// disponibilidade. Server Component puro — o clique navega para o PDP.
// `frame` (padrão) mantém a caixa com borda da home e dos relacionados; a
// coleção usa frame={false}: a moldura fica só na foto e a legenda apoia numa
// hairline, como página de revista. Sem foto, a "etiqueta de ateliê": fita +
// inicial da peça em serif.
import Link from "next/link";

import { Ribbon } from "@/components/store/ribbon";
import { eyebrow } from "@/components/store/styles";
import { cx } from "@/components/ui/cx";
import { formatCentsBRL } from "@/lib/money";
import {
  publicImageUrl,
  publicMdUrl,
  publicThumbUrl,
  type PublicProductListItem,
} from "@/services/store-catalog";

type CardSize = "cover" | "md" | "sm";

const DEFAULT_SIZES: Record<CardSize, string> = {
  cover: "(min-width: 1024px) 58vw, (min-width: 640px) 67vw, 100vw",
  md: "(min-width: 1024px) 33vw, (min-width: 640px) 33vw, 50vw",
  sm: "(min-width: 1024px) 25vw, (min-width: 640px) 33vw, 50vw",
};

export function ProductCard({
  product,
  size = "sm",
  sizes,
  priority = false,
  frame = true,
  className,
}: {
  product: PublicProductListItem;
  /** "cover" liga a rendição 1600w no desktop (só nas capas da coleção). */
  size?: CardSize;
  /** Atributo sizes do <img>; sem ele, o padrão do tamanho. */
  sizes?: string;
  /** Primeira foto da página: carrega já, com prioridade (LCP). */
  priority?: boolean;
  /** Caixa com borda e fundo (home, relacionados) ou só a foto + hairline. */
  frame?: boolean;
  className?: string;
}) {
  const soldOut = !product.available;
  const hasRange = product.priceFromCents !== product.priceToCents;
  const path = product.imagePath;
  const imgSizes = sizes ?? DEFAULT_SIZES[size];
  const cover = size === "cover";

  const photo = path ? (
    // <img> nativo de propósito (o otimizador da Vercel tem limites no plano
    // atual): thumb 400w e md 800w para todo mundo; o 1600w só entra via
    // <picture> nas capas, para o desktop retina. width/height reservam a
    // caixa antes do download (CLS zero).
    <img
      src={publicThumbUrl(path)}
      srcSet={`${publicThumbUrl(path)} 400w, ${publicMdUrl(path)} 800w`}
      sizes={imgSizes}
      alt={product.name}
      width={400}
      height={500}
      loading={priority ? "eager" : "lazy"}
      fetchPriority={priority ? "high" : undefined}
      decoding="async"
      className={cx(
        "h-full w-full object-cover transition-transform duration-700 ease-silk motion-safe:group-hover:scale-[1.04]",
        soldOut && "opacity-80 saturate-50",
      )}
    />
  ) : null;

  return (
    <Link
      href={`/produto/${product.slug}`}
      className={cx(
        "group flex h-full flex-col focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600",
        frame &&
          "overflow-hidden rounded-(--radius-hair) border border-ivory-300 bg-ivory-50 transition-colors duration-300 ease-silk hover:border-gold-500/50",
        className,
      )}
    >
      <div
        className={cx(
          "relative aspect-(--aspect-product) w-full overflow-hidden bg-ivory-150",
          !frame && "rounded-(--radius-hair) border border-ivory-300",
        )}
      >
        {photo ? (
          cover ? (
            <picture className="contents">
              <source
                media="(min-width: 1024px)"
                srcSet={`${publicMdUrl(path!)} 800w, ${publicImageUrl(path!)} 1600w`}
                sizes={imgSizes}
              />
              {photo}
            </picture>
          ) : (
            photo
          )
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
            <span
              className={cx(
                "relative font-display text-[6rem] leading-none font-semibold text-ivory-400 select-none",
                cover && "lg:text-[11rem]",
              )}
            >
              {product.name.trim().charAt(0).toUpperCase()}
            </span>
          </div>
        )}
        {product.hoverImagePath ? (
          // Segunda foto: display:none até o primeiro hover, então o navegador
          // só a baixa em quem tem hover de verdade (nunca no toque).
          <img
            src={publicThumbUrl(product.hoverImagePath)}
            srcSet={`${publicThumbUrl(product.hoverImagePath)} 400w, ${publicMdUrl(product.hoverImagePath)} 800w`}
            sizes={imgSizes}
            alt=""
            width={400}
            height={500}
            loading="lazy"
            fetchPriority="low"
            decoding="async"
            className="absolute inset-0 hidden h-full w-full object-cover group-hover:block group-focus-visible:block"
          />
        ) : null}
        {soldOut ? (
          <span className="absolute top-3 left-3 rounded-(--radius-hair) border border-ivory-300 bg-ivory-50/90 px-2.5 py-1 font-store text-[10px] font-medium tracking-[0.2em] text-ink-500 uppercase">
            Esgotado
          </span>
        ) : null}
      </div>
      <div
        className={cx(
          "flex flex-1 flex-col gap-1.5",
          frame ? "px-4 py-3" : "border-b border-ivory-300 pt-3 pb-3",
        )}
      >
        {product.brand ? <p className={eyebrow}>{product.brand}</p> : null}
        <h3
          className={cx(
            "relative",
            frame
              ? "font-store text-[15px] leading-snug font-medium text-ink-900"
              : cx(
                  "font-display leading-tight font-semibold text-espresso-900",
                  cover ? "text-heading lg:text-2xl" : "text-lg",
                ),
          )}
        >
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
