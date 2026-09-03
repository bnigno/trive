// Home da loja: véu de abertura, hero editorial, benefícios, novidades,
// categorias e convite final. Vitrine com ISR — nunca force-dynamic aqui;
// o conteúdo revalida a cada 5 minutos.
import Link from "next/link";

import { BrandVeil } from "@/components/store/brand-veil";
import { Monogram } from "@/components/store/brand/monogram";
import { Wordmark } from "@/components/store/brand/wordmark";
import {
  IconArrowRight,
  IconExchange,
  IconParcel,
  IconShield,
} from "@/components/store/icons";
import { Ornament } from "@/components/store/ornament";
import { ProductCard } from "@/components/store/product-card";
import { Reveal } from "@/components/store/reveal";
import { btnPrimary, eyebrow } from "@/components/store/styles";
import { getDb } from "@/db/client";
import { STORE_NAME_DEFAULT } from "@/lib/brand";
import { tryOrBuildFallback } from "@/lib/build-safe";
import { getSettingsMap } from "@/services/settings";
import {
  listPublicCategories,
  listPublicProducts,
} from "@/services/store-catalog";

export const revalidate = 300;

const BENEFITS = [
  {
    icon: IconParcel,
    title: "Envio para todo o Brasil",
    text: "Cada peça é embalada com cuidado e despachada para todas as regiões.",
  },
  {
    icon: IconShield,
    title: "Pagamento seguro",
    text: "Combinado via Pix, com confirmação acompanhada de perto.",
  },
  {
    icon: IconExchange,
    title: "Troca em até 7 dias",
    text: "Primeira troca facilitada, conforme o Código de Defesa do Consumidor.",
  },
] as const;

export default async function HomePage() {
  const [products, categories, settings] = await tryOrBuildFallback(
    [[], [], {}],
    () => {
      const db = getDb();
      return Promise.all([
        listPublicProducts(db, { limit: 8 }),
        listPublicCategories(db),
        getSettingsMap(db, ["store_name"]),
      ]);
    },
  );
  const storeName =
    typeof settings.store_name === "string" && settings.store_name.trim()
      ? settings.store_name.trim()
      : STORE_NAME_DEFAULT;

  return (
    <>
      <BrandVeil />
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        {/* Hero editorial — nunca dentro de <Reveal> */}
        <section className="flex flex-col items-center gap-5 py-16 text-center sm:py-24">
          <p className={eyebrow}>Maison</p>
          <h1 className="text-display text-ink-950">
            <Wordmark>{storeName}</Wordmark>
          </h1>
          <Ornament className="text-gold-500" />
          <p className="max-w-md font-display text-xl text-ink-700 italic">
            Peças escolhidas com carinho para o seu dia a dia.
          </p>
          {products.length > 0 ? (
            <Link href="/produtos" className={`mt-3 ${btnPrimary}`}>
              Ver a coleção
            </Link>
          ) : null}
        </section>

        {products.length === 0 ? (
          <section className="mb-16 flex flex-col items-center gap-4 rounded-(--radius-hair) border border-ivory-300 bg-ivory-50 px-6 py-20 text-center">
            <Ornament className="text-gold-500" />
            <p className="font-display text-heading font-semibold text-ink-950">
              Loja em preparação — volte em breve!
            </p>
            <p className="max-w-md text-sm text-ink-500">
              Estamos caprichando nos últimos detalhes. Em breve você encontra
              nossas novidades por aqui.
            </p>
          </section>
        ) : (
          <>
            <Reveal>
              <section
                aria-label="Benefícios"
                className="grid divide-y divide-ivory-300 border-y border-ivory-300 sm:grid-cols-3 sm:divide-x sm:divide-y-0"
              >
                {BENEFITS.map((benefit) => (
                  <div
                    key={benefit.title}
                    className="flex flex-col items-center gap-3 px-6 py-10 text-center"
                  >
                    <benefit.icon className="h-6 w-6 text-gold-600" />
                    <p className="font-store text-sm font-medium tracking-[0.14em] text-ink-900 uppercase">
                      {benefit.title}
                    </p>
                    <p className="max-w-xs text-sm text-ink-500">
                      {benefit.text}
                    </p>
                  </div>
                ))}
              </section>
            </Reveal>

            <section aria-labelledby="novidades" className="py-14">
              <Reveal>
                <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
                  <div>
                    <p className={eyebrow}>A coleção</p>
                    <h2
                      id="novidades"
                      className="mt-1 font-display text-title font-semibold text-ink-950"
                    >
                      Novidades
                    </h2>
                  </div>
                  <Link
                    href="/produtos"
                    className="group inline-flex items-center gap-2 font-store text-sm tracking-[0.16em] text-ink-700 uppercase transition-colors duration-300 hover:text-gold-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600"
                  >
                    Ver tudo
                    <IconArrowRight className="h-4 w-4 transition-transform duration-300 ease-silk group-hover:translate-x-1" />
                  </Link>
                </div>
              </Reveal>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {products.map((product, index) => (
                  <Reveal
                    key={product.id}
                    delay={index * 60}
                    className="h-full *:h-full"
                  >
                    <ProductCard product={product} />
                  </Reveal>
                ))}
              </div>
            </section>

            {categories.length > 0 ? (
              <section aria-labelledby="categorias" className="pb-14">
                <Reveal>
                  <div className="mb-8">
                    <p className={eyebrow}>Explore</p>
                    <h2
                      id="categorias"
                      className="mt-1 font-display text-title font-semibold text-ink-950"
                    >
                      Categorias
                    </h2>
                  </div>
                </Reveal>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                  {categories.map((category, index) => (
                    <Reveal key={category.id} delay={index * 60}>
                      <Link
                        href={`/produtos?categoria=${encodeURIComponent(category.slug)}`}
                        className="group relative flex aspect-[4/3] flex-col justify-end overflow-hidden rounded-(--radius-hair) border border-ivory-300 bg-ivory-50 p-5 transition-colors duration-300 hover:border-gold-500/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600"
                      >
                        {/* Marca-d'água editorial: inicial da categoria em serif gigante */}
                        <span
                          aria-hidden="true"
                          className="pointer-events-none absolute -top-7 right-1 font-display text-[9rem] leading-none font-semibold text-ivory-400/50 transition-transform duration-700 ease-silk select-none group-hover:scale-105"
                        >
                          {category.name.charAt(0)}
                        </span>
                        <span className="relative font-display text-heading font-semibold text-ink-950">
                          {category.name}
                        </span>
                        <span className={`relative mt-1 ${eyebrow}`}>
                          {category.productCount}{" "}
                          {category.productCount === 1 ? "produto" : "produtos"}
                        </span>
                      </Link>
                    </Reveal>
                  ))}
                </div>
              </section>
            ) : null}

            <Reveal>
              <section
                aria-label="Convite"
                className="mb-4 flex flex-col items-center gap-6 rounded-(--radius-hair) bg-ink-950 px-6 py-16 text-center"
              >
                <Monogram size={48} tone="gold" />
                <p className="max-w-xl font-display text-2xl text-ivory-100 italic sm:text-3xl">
                  Escolhido a dedo, feito para durar no seu dia a dia.
                </p>
                <Link
                  href="/produtos"
                  className="inline-flex items-center justify-center gap-2 rounded-(--radius-hair) border border-gold-500/70 px-7 py-3.5 font-store text-sm font-medium tracking-[0.16em] text-gold-300 uppercase transition-colors duration-300 ease-silk hover:border-gold-400 hover:bg-gold-400/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-400"
                >
                  Conhecer a coleção
                </Link>
              </section>
            </Reveal>
          </>
        )}
      </div>
    </>
  );
}
