// Listagem de produtos com filtro por categoria (rail tipográfico) e busca ?q=.
// Vitrine com ISR (revalidate 300); com searchParams o Next renderiza sob
// demanda — sem force-dynamic.
import type { Metadata } from "next";
import Link from "next/link";

import { Monogram } from "@/components/store/brand/monogram";
import { ProductCard } from "@/components/store/product-card";
import { Reveal } from "@/components/store/reveal";
import { btnOutline, eyebrow } from "@/components/store/styles";
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

  const railLink =
    "font-store text-xs uppercase tracking-[0.18em] transition-colors duration-300 ease-silk focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600";
  const railActive =
    "text-ink-900 underline decoration-gold-500 decoration-1 underline-offset-8";
  const railIdle = "text-ink-500 hover:text-ink-900";

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <p className={eyebrow}>
        {products.length === 1 ? "1 peça" : `${products.length} peças`}
      </p>
      <h1 className="mt-2 font-display text-title text-ink-900">{title}</h1>

      {categories.length > 0 ? (
        <nav
          aria-label="Categorias"
          className="mt-7 flex flex-wrap gap-x-6 gap-y-3"
        >
          <Link
            href={chipHref(null, q)}
            className={cx(railLink, categoria ? railIdle : railActive)}
            aria-current={categoria ? undefined : "page"}
          >
            Todas
          </Link>
          {categories.map((category) => (
            <Link
              key={category.id}
              href={chipHref(category.slug, q)}
              className={cx(
                railLink,
                category.slug === categoria ? railActive : railIdle,
              )}
              aria-current={category.slug === categoria ? "page" : undefined}
            >
              {category.name}
            </Link>
          ))}
        </nav>
      ) : null}

      {products.length === 0 ? (
        <div className="mt-12 flex flex-col items-center gap-4 rounded-(--radius-hair) border border-ivory-300 bg-ivory-50 px-6 py-20 text-center">
          <Monogram size={56} className="opacity-15" />
          <p className="font-display text-heading text-ink-900">
            Nenhum produto encontrado
          </p>
          <p className="max-w-md font-store text-sm text-ink-500">
            Tente outra busca ou navegue pelas categorias.
          </p>
          <Link href="/produtos" className={cx(btnOutline, "mt-2")}>
            Ver todos os produtos
          </Link>
        </div>
      ) : (
        <div className="mt-10 grid grid-cols-2 gap-x-5 gap-y-10 sm:grid-cols-3 lg:grid-cols-4">
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
      )}
    </div>
  );
}
