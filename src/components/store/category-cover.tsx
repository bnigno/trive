// Capa de uma sala: a foto enviada no painel (com o foco vertical escolhido,
// porque a mesma imagem serve ao card 4:5 da home e à faixa larga da coleção)
// ou, sem foto, a marca-d'água tipográfica com a fita. Server Component; a
// legenda (nome, contagem) fica sempre FORA da foto, em marfim sólido.
import { Ribbon } from "@/components/store/ribbon";
import { cx } from "@/components/ui/cx";
import {
  publicImageUrl,
  publicMdUrl,
  publicThumbUrl,
  type PublicCategory,
} from "@/services/store-catalog";

type CoverSize = "card" | "edition";

const FRAME: Record<CoverSize, string> = {
  card: "aspect-(--aspect-product)",
  edition: "aspect-[16/9] lg:aspect-[21/7]",
};

export function CategoryCover({
  category,
  size,
  sizes,
  className,
}: {
  category: Pick<PublicCategory, "name" | "coverPath" | "coverFocalY">;
  size: CoverSize;
  /** Atributo sizes do <img>, com as colunas reais de onde a capa aparece. */
  sizes: string;
  className?: string;
}) {
  const path = category.coverPath;

  if (!path) {
    return (
      <div
        aria-hidden="true"
        className={cx(
          "relative overflow-hidden rounded-(--radius-hair) border border-ivory-300 bg-ivory-50",
          FRAME[size],
          className,
        )}
      >
        <span className="pointer-events-none absolute -top-8 right-1 font-display text-[10rem] leading-none font-semibold text-ivory-400/50 transition-transform duration-700 ease-silk select-none group-hover:-translate-y-1">
          {category.name.trim().charAt(0).toUpperCase()}
        </span>
        <Ribbon
          variant="static"
          size="md"
          className="absolute bottom-6 left-5 opacity-30"
        />
      </div>
    );
  }

  const image = (
    <img
      src={publicMdUrl(path)}
      srcSet={`${publicThumbUrl(path)} 400w, ${publicMdUrl(path)} 800w`}
      sizes={sizes}
      alt=""
      width={800}
      height={size === "card" ? 1000 : 450}
      loading="lazy"
      decoding="async"
      style={{ objectPosition: `50% ${category.coverFocalY}%` }}
      className="h-full w-full object-cover transition-transform duration-700 ease-silk motion-safe:group-hover:scale-[1.04]"
    />
  );

  return (
    <div
      className={cx(
        "relative overflow-hidden bg-ivory-150",
        size === "card" && "rounded-(--radius-hair) border border-ivory-300",
        FRAME[size],
        className,
      )}
    >
      {size === "edition" ? (
        <picture>
          {/* Desktop retina recebe o 1600w; o celular nunca vê esse arquivo. */}
          <source
            media="(min-width: 1024px)"
            srcSet={`${publicMdUrl(path)} 800w, ${publicImageUrl(path)} 1600w`}
            sizes={sizes}
          />
          {image}
        </picture>
      ) : (
        image
      )}
      {size === "edition" ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-ivory-100 via-ivory-100/85 to-ivory-100/0"
        />
      ) : null}
    </div>
  );
}
