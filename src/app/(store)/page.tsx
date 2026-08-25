// Home da loja: hero, grade de novidades e categorias. Vitrine com ISR —
// nunca force-dynamic aqui; o conteúdo revalida a cada 5 minutos.
import Link from "next/link";

import { ProductCard } from "@/components/store/product-card";
import { getDb } from "@/db/client";
import { getSettingsMap } from "@/services/settings";
import {
  listPublicCategories,
  listPublicProducts,
} from "@/services/store-catalog";

export const revalidate = 300;

export default async function HomePage() {
  const db = getDb();
  const [products, categories, settings] = await Promise.all([
    listPublicProducts(db, { limit: 8 }),
    listPublicCategories(db),
    getSettingsMap(db, ["store_name"]),
  ]);
  const storeName =
    typeof settings.store_name === "string" && settings.store_name.trim()
      ? settings.store_name.trim()
      : "TRIVË";

  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6">
      <section className="flex flex-col items-center gap-4 py-14 text-center sm:py-20">
        <h1 className="text-4xl font-semibold tracking-[0.25em] sm:text-5xl">
          {storeName}
        </h1>
        <div className="h-px w-20 bg-amber-700/60" aria-hidden="true" />
        <p className="max-w-md text-lg text-zinc-600 dark:text-zinc-400">
          Peças escolhidas com carinho para o seu dia a dia.
        </p>
        {products.length > 0 ? (
          <Link
            href="/produtos"
            className="mt-2 rounded-full bg-amber-700 px-6 py-3 text-sm font-medium text-white transition hover:bg-amber-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
          >
            Ver todos os produtos
          </Link>
        ) : null}
      </section>

      {products.length === 0 ? (
        <section className="flex flex-col items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-6 py-16 text-center dark:border-amber-900 dark:bg-amber-950/30">
          <p className="text-lg font-medium text-amber-900 dark:text-amber-200">
            Loja em preparação — volte em breve!
          </p>
          <p className="max-w-md text-sm text-amber-800/80 dark:text-amber-300/80">
            Estamos caprichando nos últimos detalhes. Em breve você encontra
            nossas novidades por aqui.
          </p>
        </section>
      ) : (
        <>
          <section aria-labelledby="novidades" className="pb-4">
            <h2
              id="novidades"
              className="mb-5 text-2xl font-semibold text-zinc-900 dark:text-zinc-100"
            >
              Novidades
            </h2>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {products.map((product) => (
                <ProductCard key={product.id} product={product} />
              ))}
            </div>
          </section>

          {categories.length > 0 ? (
            <section aria-labelledby="categorias" className="py-10">
              <h2
                id="categorias"
                className="mb-4 text-2xl font-semibold text-zinc-900 dark:text-zinc-100"
              >
                Categorias
              </h2>
              <div className="flex flex-wrap gap-2">
                {categories.map((category) => (
                  <Link
                    key={category.id}
                    href={`/produtos?categoria=${encodeURIComponent(category.slug)}`}
                    className="rounded-full border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-700 transition hover:border-amber-700 hover:text-amber-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-amber-500 dark:hover:text-amber-400"
                  >
                    {category.name}
                    <span className="ml-1.5 text-xs text-zinc-400">
                      {category.productCount}
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
