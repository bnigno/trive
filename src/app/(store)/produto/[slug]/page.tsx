// Página de produto (PDP): galeria, seletor de variação e compra.
// Vitrine com ISR — revalida a cada 5 minutos; nunca force-dynamic.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { getDb } from "@/db/client";
import {
  getPublicProductBySlug,
  publicImageUrl,
  publicThumbUrl,
} from "@/services/store-catalog";

import { ProductGallery } from "./gallery";
import { VariantPicker } from "./variant-picker";

export const revalidate = 300;

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const product = await getPublicProductBySlug(getDb(), slug);
  if (!product) return { title: "Produto não encontrado" };

  const description =
    product.description?.trim().slice(0, 160) ||
    `${product.name} — compre online.`;
  return {
    title: product.name,
    description,
    openGraph: {
      title: product.name,
      description,
      type: "website",
      images: product.images[0]
        ? [{ url: publicImageUrl(product.images[0]), alt: product.name }]
        : undefined,
    },
  };
}

export default async function ProdutoPage({ params }: Props) {
  const { slug } = await params;
  const product = await getPublicProductBySlug(getDb(), slug);
  if (!product) notFound();

  const galleryImages = product.images.map((path) => ({
    full: publicImageUrl(path),
    thumb: publicThumbUrl(path),
  }));
  const cartImageUrl = product.images[0]
    ? publicThumbUrl(product.images[0])
    : undefined;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <nav aria-label="Navegação" className="mb-6 text-sm">
        <Link
          href="/produtos"
          className="text-zinc-500 hover:text-amber-800 dark:text-zinc-400 dark:hover:text-amber-400"
        >
          ← Voltar aos produtos
        </Link>
      </nav>

      <div className="grid gap-8 lg:grid-cols-2 lg:gap-12">
        <ProductGallery images={galleryImages} alt={product.name} />

        <div className="flex flex-col gap-4">
          <div>
            {product.brand ? (
              <p className="text-sm uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                {product.brand}
              </p>
            ) : null}
            <h1 className="mt-1 text-2xl font-semibold leading-tight text-zinc-900 sm:text-3xl dark:text-zinc-100">
              {product.name}
            </h1>
            {product.categoryName ? (
              <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                {product.categoryName}
              </p>
            ) : null}
          </div>

          <VariantPicker
            productName={product.name}
            slug={product.slug}
            imageUrl={cartImageUrl}
            axes={product.attributesSchema}
            variants={product.variants}
          />

          {product.description ? (
            <section aria-labelledby="descricao" className="mt-4">
              <h2
                id="descricao"
                className="mb-2 text-lg font-semibold text-zinc-900 dark:text-zinc-100"
              >
                Descrição
              </h2>
              <p className="whitespace-pre-line text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                {product.description}
              </p>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
