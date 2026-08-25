// Listagem de produtos com filtro por categoria (chips) e busca ?q=.
// Vitrine com ISR (revalidate 300); com searchParams o Next renderiza sob
// demanda — sem force-dynamic.
import type { Metadata } from "next";
import Link from "next/link";

import { ProductCard } from "@/components/store/product-card";
import { cx } from "@/components/ui/cx";
import { getDb } from "@/db/client";
import {
  listPublicCategories,
  listPublicProducts,
} from "@/services/store-catalog";

export const revalidate = 300;

export const metadata: Metadata = {
  title: "Produtos",
  description: "Todos os produtos da loja.",
};

function chipHref(categoria: string | null, q: string): string {
  const params = new URLSearchParams();
  if (categoria) params.set("categoria", categoria);
  if (q) params.set("q", q);
  const query = params.toString();
  return query ? `/produtos?${query}` : "/produtos";
}

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
    : (activeCategory?.name ?? "Todos os produtos");

  const chipBase =
    "rounded-full border px-4 py-1.5 text-sm transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700";
  const chipActive =
    "border-amber-700 bg-amber-700 text-white dark:border-amber-600 dark:bg-amber-700";
  const chipIdle =
    "border-zinc-300 bg-white text-zinc-700 hover:border-amber-700 hover:text-amber-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-amber-500 dark:hover:text-amber-400";

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold text-zinc-900 sm:text-3xl dark:text-zinc-100">
        {title}
      </h1>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        {products.length === 1
          ? "1 produto encontrado"
          : `${products.length} produtos encontrados`}
      </p>

      {categories.length > 0 ? (
        <nav aria-label="Categorias" className="mt-5 flex flex-wrap gap-2">
          <Link
            href={chipHref(null, q)}
            className={cx(chipBase, categoria ? chipIdle : chipActive)}
            aria-current={categoria ? undefined : "page"}
          >
            Todas
          </Link>
          {categories.map((category) => (
            <Link
              key={category.id}
              href={chipHref(category.slug, q)}
              className={cx(
                chipBase,
                category.slug === categoria ? chipActive : chipIdle,
              )}
              aria-current={category.slug === categoria ? "page" : undefined}
            >
              {category.name}
            </Link>
          ))}
        </nav>
      ) : null}

      {products.length === 0 ? (
        <div className="mt-10 flex flex-col items-center gap-3 rounded-2xl border border-zinc-200 bg-white px-6 py-16 text-center dark:border-zinc-800 dark:bg-zinc-900">
          <p className="text-lg font-medium text-zinc-800 dark:text-zinc-200">
            Nenhum produto encontrado
          </p>
          <p className="max-w-md text-sm text-zinc-500 dark:text-zinc-400">
            Tente outra busca ou navegue pelas categorias.
          </p>
          <Link
            href="/produtos"
            className="mt-2 rounded-full bg-amber-700 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-amber-800"
          >
            Ver todos os produtos
          </Link>
        </div>
      ) : (
        <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {products.map((product) => (
            <ProductCard key={product.id} product={product} />
          ))}
        </div>
      )}
    </div>
  );
}
