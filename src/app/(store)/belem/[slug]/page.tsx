// /belem/<slug> — a página de uma Edição de Belém: capa, frase de abertura,
// a palavra da curadora, bairros e as peças escolhidas. ISR de 5 min: a
// dona muda no painel e a vitrine acompanha (as actions também revalidam).
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { EditionCover } from "@/components/store/city-edition-section";
import { EditorialGrid } from "@/components/store/editorial-grid";
import { EmptyState } from "@/components/store/empty-state";
import { Ribbon } from "@/components/store/ribbon";
import { btnOutline, eyebrow } from "@/components/store/styles";
import { getDb } from "@/db/client";
import { tryOrBuildFallback } from "@/lib/build-safe";
import { arrangeEdition } from "@/lib/editorial-rhythm";
import { siteUrl } from "@/lib/site-url";
import { getPublicCityEditionBySlug } from "@/services/city-editions";
import { listPublicProducts, publicImageUrl } from "@/services/store-catalog";

export const revalidate = 300;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const edition = await tryOrBuildFallback(null, () => getPublicCityEditionBySlug(getDb(), slug));
  if (!edition) return { title: "Edição não encontrada", robots: { index: false } };
  const title = edition.name;
  const description = edition.openingLine ?? edition.bodyParagraphs[0]?.slice(0, 160) ?? `A ${edition.name}, escolhida para Belém.`;
  const url = `${siteUrl()}/belem/${edition.slug}`;
  return {
    title,
    description,
    alternates: { canonical: `/belem/${edition.slug}` },
    openGraph: {
      title,
      description,
      url,
      type: "website",
      ...(edition.coverPath ? { images: [{ url: publicImageUrl(edition.coverPath) }] } : {}),
    },
  };
}

export default async function BelemEditionPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const edition = await tryOrBuildFallback(null, () => getPublicCityEditionBySlug(getDb(), slug));
  if (!edition) notFound();
  const products = arrangeEdition(await tryOrBuildFallback([], () => listPublicProducts(getDb(), { editionSlug: edition.slug, limit: 60 })));
  const firstWithPhoto = products.findIndex((product) => product.imagePath);
  const priorityIndex = firstWithPhoto >= 0 && firstWithPhoto < 2 ? firstWithPhoto : -1;
  const timing = edition.isCurrent
    ? edition.periodLabel === "sempre"
      ? "No ar"
      : `No ar · ${edition.periodLabel}`
    : edition.daysUntil !== null && edition.daysUntil > 0
      ? `Em ${edition.daysUntil} ${edition.daysUntil === 1 ? "dia" : "dias"} · ${edition.periodLabel}`
      : edition.periodLabel;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <EditionCover edition={edition} fallbackImagePath={products[0]?.imagePath ?? null} className="aspect-[16/9] lg:aspect-[21/8]" priority />

      <header className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-16">
        <div className="flex flex-col items-start gap-3">
          <p className={eyebrow}>Edições de Belém · {timing}</p>
          <h1 className="font-display text-display font-semibold text-balance text-espresso-900 lg:text-[5.25rem] lg:leading-[0.95]">{edition.name}</h1>
          <Ribbon variant="enter" size="sm" />
          {edition.openingLine ? (
            <p className="mt-2 font-display text-2xl leading-snug font-normal text-balance text-espresso-900 italic sm:text-3xl">{edition.openingLine}</p>
          ) : null}
        </div>
        <div className="flex flex-col gap-4 lg:pt-10">
          {edition.bodyParagraphs.map((paragraph, index) => (
            <p key={index} className="max-w-prose font-store text-base leading-relaxed text-ink-700">
              {paragraph}
            </p>
          ))}
          {edition.districts.length > 0 ? (
            <p className="font-store text-sm text-ink-500">
              <span className={eyebrow}>Entregamos por motoboy em</span>
              <span className="block">{edition.districts.join(" · ")}</span>
            </p>
          ) : null}
        </div>
      </header>

      {products.length === 0 ? (
        <div className="mt-10">
          <EmptyState
            title="As peças desta edição estão chegando"
            hint="Enquanto isso, a coleção inteira está aberta."
            action={
              <Link href="/produtos" className={btnOutline}>
                Ver toda a coleção
              </Link>
            }
          />
        </div>
      ) : (
        <section aria-labelledby="pecas" className="mt-10 lg:mt-14">
          <h2 id="pecas" className="sr-only">
            Peças da edição
          </h2>
          <EditorialGrid products={products} priorityIndex={priorityIndex} />
        </section>
      )}
    </div>
  );
}
