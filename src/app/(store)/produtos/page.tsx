// A coleção: listagem com busca inline (#busca, alvo da lupa do header no
// celular), trilho de salas fixo abaixo do header e grade de peças. A rota lê
// searchParams, então o Next a renderiza sob demanda — sem force-dynamic.
import type { Metadata } from "next";
import Link from "next/link";

import { CategoryIndex } from "@/components/store/category-index";
import { EmptyState } from "@/components/store/empty-state";
import { IconSearch } from "@/components/store/icons";
import { ProductCard } from "@/components/store/product-card";
import { RailScroll } from "@/components/store/rail-scroll";
import { Reveal } from "@/components/store/reveal";
import { Ribbon } from "@/components/store/ribbon";
import { btnOutline, eyebrow, inputBase } from "@/components/store/styles";
import { cx } from "@/components/ui/cx";
import { getDb } from "@/db/client";
import {
  listPublicCategories,
  listPublicProducts,
} from "@/services/store-catalog";

export const metadata: Metadata = {
  title: "A coleção",
  description: "Todas as peças da maison, por sala ou por busca.",
};

function chipHref(categoria: string | null, q: string): string {
  const params = new URLSearchParams();
  if (categoria) params.set("categoria", categoria);
  if (q) params.set("q", q);
  const query = params.toString();
  return query ? `/produtos?${query}` : "/produtos";
}

const chip =
  "inline-flex min-h-11 shrink-0 snap-center items-center border-b-2 font-store text-xs tracking-[0.18em] whitespace-nowrap uppercase transition-colors duration-300 ease-silk focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600";
const chipActive = "border-gold-700 text-espresso-900";
const chipIdle = "border-transparent text-ink-500 hover:text-ink-900";

export default async function ProdutosPage({
  searchParams,
}: {
  searchParams: Promise<{ categoria?: string; q?: string }>;
}) {
  const params = await searchParams;
  const categoria = (params.categoria ?? "").trim();
  const q = (params.q ?? "").trim();

  const db = getDb();
  const [products, categories] = await Promise.all([
    listPublicProducts(db, {
      categorySlug: categoria || undefined,
      q: q || undefined,
      limit: 60,
    }),
    listPublicCategories(db),
  ]);

  const activeCategory = categories.find((c) => c.slug === categoria);
  const title = q
    ? `Resultados para “${q}”`
    : (activeCategory?.name ?? "A coleção");

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <header className="flex flex-col items-start gap-3">
        <p className={eyebrow}>
          {products.length === 1 ? "1 peça" : `${products.length} peças`}
        </p>
        <h1 className="font-display text-title font-semibold text-balance text-espresso-900">
          {title}
        </h1>
        <Ribbon variant="static" size="sm" />
        {q ? (
          <Link
            href={chipHref(categoria || null, "")}
            className="inline-flex min-h-11 items-center font-store text-xs tracking-[0.16em] text-ink-700 uppercase underline decoration-gold-500 underline-offset-4 transition-colors hover:text-gold-800"
          >
            Limpar busca
          </Link>
        ) : null}
      </header>

      <form
        action="/produtos"
        method="GET"
        role="search"
        className="mt-6 max-w-md"
      >
        <label htmlFor="busca" className="sr-only">
          Buscar na coleção
        </label>
        <div className="relative">
          <IconSearch className="pointer-events-none absolute top-1/2 left-0 h-4 w-4 -translate-y-1/2 text-ink-400" />
          <input
            id="busca"
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Buscar na coleção…"
            className={cx(inputBase, "min-h-11 pl-6")}
          />
          {categoria ? (
            <input type="hidden" name="categoria" value={categoria} />
          ) : null}
        </div>
      </form>

      {categories.length > 0 ? (
        <nav
          aria-label="Salas da maison"
          className="sticky top-(--header-h) z-30 mt-6 border-b border-ivory-300 bg-ivory-100/95 py-1 lg:backdrop-blur"
        >
          <RailScroll>
            <Link
              href={chipHref(null, q)}
              className={cx(chip, categoria ? chipIdle : chipActive)}
              aria-current={categoria ? undefined : "page"}
            >
              Todas
            </Link>
            {categories.map((category) => (
              <Link
                key={category.id}
                href={chipHref(category.slug, q)}
                className={cx(
                  chip,
                  category.slug === categoria ? chipActive : chipIdle,
                )}
                aria-current={category.slug === categoria ? "page" : undefined}
              >
                {category.name}
              </Link>
            ))}
          </RailScroll>
        </nav>
      ) : null}

      {products.length === 0 ? (
        <div className="mt-10">
          <EmptyState
            title="Nada por aqui ainda"
            hint="Tente outra palavra ou entre em uma das salas da maison."
            action={
              <Link href="/produtos" className={btnOutline}>
                Ver toda a coleção
              </Link>
            }
          >
            <CategoryIndex categories={categories} compact />
          </EmptyState>
        </div>
      ) : (
        // h2 invisível: os cards são h3 e a ordem de títulos (h1 → h2 → h3)
        // é o que leitores de tela e o Lighthouse esperam.
        <section aria-labelledby="pecas" className="mt-8">
          <h2 id="pecas" className="sr-only">
            Peças
          </h2>
          <div className="grid grid-cols-2 gap-x-3 gap-y-7 sm:grid-cols-3 sm:gap-x-5 lg:grid-cols-4">
            {products.map((product, index) =>
              index < 12 ? (
                <Reveal key={product.id} delay={index * 60} className="h-full">
                  <ProductCard product={product} />
                </Reveal>
              ) : (
                <ProductCard key={product.id} product={product} />
              ),
            )}
          </div>
        </section>
      )}
    </div>
  );
}
