// Página de produto (PDP), "o camarim": galeria, seletor de variação, compra,
// fichas em <details> e peças relacionadas. Vitrine com ISR — revalida a cada
// 5 minutos; nunca force-dynamic.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { IconChevron } from "@/components/store/icons";
import { ProductCard } from "@/components/store/product-card";
import { SectionHeading } from "@/components/store/section-heading";
import { getDb } from "@/db/client";
import {
  getPublicProductBySlug,
  listRelatedPublicProducts,
  publicImageUrl,
  publicMdUrl,
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

const crumb =
  "font-store text-eyebrow font-medium text-ink-500 uppercase transition-colors duration-300 ease-silk hover:text-gold-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600";

/** Ficha dobrável (nativa, sem JS): título serif + chevron que gira ao abrir.
 *  "Details" no nome para não colidir com a folha de papel de order/sheet. */
function DetailsSheet({
  title,
  open = false,
  children,
}: {
  title: string;
  open?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details open={open} className="group border-t border-ivory-300 py-4">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 font-display text-heading font-semibold text-espresso-900 [&::-webkit-details-marker]:hidden">
        {title}
        <IconChevron className="h-5 w-5 shrink-0 text-gold-700 transition-transform duration-300 ease-silk group-open:rotate-180" />
      </summary>
      <div className="pt-3 font-store text-[15px] leading-7 text-ink-700">
        {children}
      </div>
    </details>
  );
}

export default async function ProdutoPage({ params }: Props) {
  const { slug } = await params;
  const db = getDb();
  const product = await getPublicProductBySlug(db, slug);
  if (!product) notFound();

  const related = await listRelatedPublicProducts(db, {
    productId: product.id,
    categorySlug: product.categorySlug,
    limit: 4,
  });

  // Todas as fotos vão para o cliente com a cor a que pertencem; quem decide o
  // que aparece é a cor escolhida no seletor (core/catalog/product-images).
  const galleryImages = product.images.map((image) => ({
    full: publicImageUrl(image.path),
    md: publicMdUrl(image.path),
    thumb: publicThumbUrl(image.path),
    color: image.color,
  }));

  return (
    // pb-24 reserva o espaço da barra fixa de compra no celular.
    <div className="mx-auto max-w-6xl px-4 py-8 pb-24 sm:px-6 lg:pb-8">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: buildProductJsonLd(product) }}
      />
      <nav aria-label="Navegação" className="mb-8 flex flex-wrap items-center gap-2">
        <Link href="/produtos" className={crumb}>
          Coleção
        </Link>
        {product.categoryName && product.categorySlug ? (
          <>
            <span aria-hidden="true" className="text-gold-500">
              ·
            </span>
            <Link
              href={`/produtos?categoria=${encodeURIComponent(product.categorySlug)}`}
              className={crumb}
            >
              {product.categoryName}
            </Link>
          </>
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
              <p className="font-store text-eyebrow font-medium text-rose-700 uppercase">
                {product.brand}
              </p>
            ) : null}
            <h1 className="mt-2 font-display text-title font-semibold text-balance text-espresso-900">
              {product.name}
            </h1>
          </div>
        }
      >
        <div className="mt-4 border-b border-ivory-300">
          {product.description ? (
            <DetailsSheet title="Descrição" open>
              <p className="whitespace-pre-line">{product.description}</p>
            </DetailsSheet>
          ) : null}
          <DetailsSheet title="Envio e trocas">
            <p>
              Enviamos para todo o Brasil. Primeira troca em até 7 dias corridos
              após o recebimento, conforme o Código de Defesa do Consumidor.
            </p>
          </DetailsSheet>
          <DetailsSheet title="Cuidados com a peça">
            <p>
              Lave à mão ou no ciclo delicado, com água fria. Seque à sombra e
              passe do avesso. Cada peça vem com instruções próprias na etiqueta.
            </p>
          </DetailsSheet>
        </div>
      </ProductDetailClient>

      {related.items.length > 0 ? (
        <section aria-labelledby="relacionados" className="mt-16">
          <SectionHeading
            eyebrow={related.scope === "category" ? "Na mesma sala" : "Novidades"}
            title={related.scope === "category" ? "Também na maison" : "Mais da maison"}
            id="relacionados"
          />
          <div className="grid grid-cols-2 gap-x-3 gap-y-10 sm:gap-x-5 lg:grid-cols-4">
            {related.items.map((item) => (
              <ProductCard key={item.id} product={item} size="sm" />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
