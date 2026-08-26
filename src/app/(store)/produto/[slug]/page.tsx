// Página de produto (PDP): galeria, seletor de variação e compra.
// Vitrine com ISR — revalida a cada 5 minutos; nunca force-dynamic.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Ornament } from "@/components/store/ornament";
import { getDb } from "@/db/client";
import {
  getPublicProductBySlug,
  publicImageUrl,
  publicThumbUrl,
} from "@/services/store-catalog";

import { ProductDetailClient } from "./product-detail-client";

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
        ? [{ url: publicImageUrl(product.images[0].path), alt: product.name }]
        : undefined,
    },
  };
}

/**
 * JSON-LD Product para buscadores (Google Shopping/rich results), montado com
 * os dados já carregados. Serializado com escape de `<` (<) para nunca
 * fechar a tag <script> mesmo que nome/descrição contenham HTML.
 */
function buildProductJsonLd(product: {
  name: string;
  slug: string;
  description: string | null;
  brand: string | null;
  images: { path: string }[];
  variants: { priceCents: number; availableQty: number }[];
}): string {
  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL || "https://trivemaison.com.br";
  const prices = product.variants.map((variant) => variant.priceCents);
  const cheapestCents = prices.length > 0 ? Math.min(...prices) : null;
  const inStock = product.variants.some((variant) => variant.availableQty > 0);

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.name,
    ...(product.images.length > 0
      ? { image: product.images.map((image) => publicImageUrl(image.path)) }
      : {}),
    ...(product.description?.trim()
      ? { description: product.description.trim() }
      : {}),
    ...(product.brand
      ? { brand: { "@type": "Brand", name: product.brand } }
      : {}),
    ...(cheapestCents !== null
      ? {
          offers: {
            "@type": "Offer",
            url: `${siteUrl}/produto/${product.slug}`,
            priceCurrency: "BRL",
            price: (cheapestCents / 100).toFixed(2),
            availability: inStock
              ? "https://schema.org/InStock"
              : "https://schema.org/OutOfStock",
          },
        }
      : {}),
  };
  return JSON.stringify(jsonLd).replace(/</g, "\\u003c");
}

export default async function ProdutoPage({ params }: Props) {
  const { slug } = await params;
  const product = await getPublicProductBySlug(getDb(), slug);
  if (!product) notFound();

  // Todas as fotos vão para o cliente com a cor a que pertencem; quem decide o
  // que aparece é a cor escolhida no seletor (core/catalog/product-images).
  const galleryImages = product.images.map((image) => ({
    full: publicImageUrl(image.path),
    thumb: publicThumbUrl(image.path),
    color: image.color,
  }));

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: buildProductJsonLd(product) }}
      />
      <nav aria-label="Navegação" className="mb-8">
        <Link
          href="/produtos"
          className="font-store text-eyebrow font-medium uppercase text-ink-500 transition-colors duration-300 ease-silk hover:text-gold-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600"
        >
          Produtos
        </Link>
        {product.categoryName ? (
          <span className="font-store text-eyebrow font-medium uppercase text-ink-400">
            {" / "}
            {product.categoryName}
          </span>
        ) : null}
      </nav>

      <ProductDetailClient
        productName={product.name}
        slug={product.slug}
        axes={product.attributesSchema}
        variants={product.variants}
        images={galleryImages}
        heading={
          <div>
            {product.brand ? (
              <p className="font-store text-eyebrow font-medium uppercase text-gold-800">
                {product.brand}
              </p>
            ) : null}
            <h1 className="mt-2 font-display text-title text-ink-900">
              {product.name}
            </h1>
          </div>
        }
      >
        {product.description ? (
          <section aria-labelledby="descricao" className="mt-6">
            <h2
              id="descricao"
              className="font-display text-heading text-ink-900"
            >
              Descrição
            </h2>
            <Ornament className="mt-3 w-20 text-gold-500" />
            <p className="mt-4 whitespace-pre-line font-store text-[15px] leading-7 text-ink-700">
              {product.description}
            </p>
          </section>
        ) : null}
      </ProductDetailClient>
    </div>
  );
}
