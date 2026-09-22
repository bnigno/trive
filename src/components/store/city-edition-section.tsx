// "Edições de Belém": a curadoria com data e lugar, na home (a vigente) e
// em /belem/<slug> (a página inteira). Server Component: só apresenta o que
// a página já buscou. A capa é a foto enviada no painel (JPEG único, sem
// renditions) ou, sem capa, a primeira peça da edição.
import Link from "next/link";

import { IconArrowRight } from "@/components/store/icons";
import { ProductCard } from "@/components/store/product-card";
import { Reveal } from "@/components/store/reveal";
import { Ribbon } from "@/components/store/ribbon";
import { SectionHeading } from "@/components/store/section-heading";
import { cx } from "@/components/ui/cx";
import type { PublicCityEdition } from "@/services/city-editions";
import { publicImageUrl, publicMdUrl, type PublicProductListItem } from "@/services/store-catalog";

export function EditionCover({
  edition,
  fallbackImagePath,
  className,
  priority = false,
}: {
  edition: Pick<PublicCityEdition, "name" | "coverPath" | "openingLine">;
  fallbackImagePath: string | null;
  className?: string;
  priority?: boolean;
}) {
  const src = edition.coverPath ? publicImageUrl(edition.coverPath) : fallbackImagePath ? publicMdUrl(fallbackImagePath) : null;
  return (
    <div className={cx("relative overflow-hidden rounded-(--radius-hair) border border-ivory-300 bg-ivory-50", className)}>
      {src ? (
         
        <img
          src={src}
          alt={edition.openingLine ? `${edition.name} — ${edition.openingLine}` : edition.name}
          className="h-full w-full object-cover"
          loading={priority ? "eager" : "lazy"}
          fetchPriority={priority ? "high" : "auto"}
        />
      ) : (
        <div aria-hidden="true" className="flex h-full w-full items-end p-6">
          <span className="pointer-events-none absolute -top-8 right-1 font-display text-[10rem] leading-none font-semibold text-ivory-400/50 select-none">
            {edition.name.trim().charAt(0).toUpperCase()}
          </span>
          <Ribbon variant="static" size="md" className="opacity-30" />
        </div>
      )}
    </div>
  );
}

/** Seção da home: a edição vigente com capa, frase, primeiro parágrafo e até 4 peças. */
export function CityEditionSection({ edition, products }: { edition: PublicCityEdition; products: PublicProductListItem[] }) {
  const shown = products.slice(0, 4);
  return (
    <section aria-labelledby="edicao-belem" className="py-12">
      <SectionHeading
        eyebrow={`Edições de Belém${edition.periodLabel !== "sempre" ? ` · ${edition.periodLabel}` : ""}`}
        title={edition.name}
        id="edicao-belem"
        aside={
          <Link
            href={`/belem/${edition.slug}`}
            className="group inline-flex min-h-11 items-center gap-2 font-store text-sm tracking-[0.16em] text-ink-700 uppercase transition-colors duration-300 hover:text-gold-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600"
          >
            Ver a edição
            <IconArrowRight className="h-4 w-4 transition-transform duration-300 ease-silk group-hover:translate-x-1" />
          </Link>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-start lg:gap-10">
        <Link href={`/belem/${edition.slug}`} className="group block">
          <EditionCover edition={edition} fallbackImagePath={shown[0]?.imagePath ?? null} className="aspect-[4/3] lg:aspect-[4/5]" />
        </Link>
        <div className="flex flex-col gap-5">
          {edition.openingLine ? (
            <p className="font-display text-2xl leading-snug font-semibold text-balance text-espresso-900 sm:text-3xl">{edition.openingLine}</p>
          ) : null}
          {edition.bodyParagraphs[0] ? <p className="max-w-prose font-store text-base leading-relaxed text-ink-700">{edition.bodyParagraphs[0]}</p> : null}
          {shown.length > 0 ? (
            <div className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-4 lg:gap-4">
              {shown.map((product, index) => (
                <Reveal key={product.id} delay={index * 60} className="h-full *:h-full">
                  <ProductCard product={product} />
                </Reveal>
              ))}
            </div>
          ) : (
            <p className="font-store text-sm text-ink-500">As peças desta edição estão chegando.</p>
          )}
        </div>
      </div>
    </section>
  );
}
