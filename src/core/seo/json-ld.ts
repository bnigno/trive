// Dados estruturados para buscadores — PURO. Organization e WebSite no layout
// da vitrine, Product na página da peça. Serialização com escape de "<":
// nome/descrição nunca fecham a tag <script>.

export type OrganizationJsonLdInput = {
  name: string;
  url: string;
  logoUrl: string;
  email?: string;
  whatsappE164?: string;
};

export function buildOrganizationJsonLd(input: OrganizationJsonLdInput): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: input.name,
    url: input.url,
    logo: input.logoUrl,
    ...(input.email ? { email: input.email } : {}),
    ...(input.whatsappE164
      ? {
          contactPoint: [
            {
              "@type": "ContactPoint",
              telephone: input.whatsappE164,
              contactType: "customer service",
              availableLanguage: "Portuguese",
            },
          ],
        }
      : {}),
  };
}

export function buildWebSiteJsonLd(input: { name: string; url: string }): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: input.name,
    url: input.url,
    inLanguage: "pt-BR",
    potentialAction: {
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: `${input.url}/produtos?q={search_term_string}`,
      },
      "query-input": "required name=search_term_string",
    },
  };
}

export type ProductJsonLdInput = {
  name: string;
  slug: string;
  description: string | null;
  composition?: string | null;
  brand: string | null;
  imageUrls: string[];
  variants: { priceCents: number; availableQty: number }[];
};

/** Product para rich results: menor preço ativo, disponibilidade, material. */
export function buildProductJsonLd(product: ProductJsonLdInput, siteUrl: string): Record<string, unknown> {
  const prices = product.variants.map((variant) => variant.priceCents);
  const cheapestCents = prices.length > 0 ? Math.min(...prices) : null;
  const inStock = product.variants.some((variant) => variant.availableQty > 0);
  const productUrl = `${siteUrl}/produto/${product.slug}`;
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.name,
    url: productUrl,
    ...(product.imageUrls.length > 0 ? { image: product.imageUrls } : {}),
    ...(product.description?.trim() ? { description: product.description.trim() } : {}),
    ...(product.brand ? { brand: { "@type": "Brand", name: product.brand } } : {}),
    ...(product.composition?.trim() ? { material: product.composition.trim() } : {}),
    ...(cheapestCents !== null
      ? {
          offers: {
            "@type": "Offer",
            url: productUrl,
            priceCurrency: "BRL",
            price: (cheapestCents / 100).toFixed(2),
            availability: inStock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
          },
        }
      : {}),
  };
}

/** JSON para dentro de <script type="application/ld+json">, sem fechar a tag. */
export function serializeJsonLd(value: Record<string, unknown>): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
