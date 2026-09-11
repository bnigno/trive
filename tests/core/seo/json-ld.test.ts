import { describe, expect, it } from "vitest";

import {
  buildOrganizationJsonLd,
  buildProductJsonLd,
  buildWebSiteJsonLd,
  serializeJsonLd,
} from "@/core/seo/json-ld";

describe("JSON-LD", () => {
  it("Organization com e sem contato", () => {
    const full = buildOrganizationJsonLd({
      name: "TRIVÉ",
      url: "https://trivemaison.com.br",
      logoUrl: "https://trivemaison.com.br/brand/mark-dark-400.webp",
      email: "contato@trivemaison.com.br",
      whatsappE164: "+5591999990000",
    });
    expect(full).toMatchObject({ "@type": "Organization", name: "TRIVÉ", email: "contato@trivemaison.com.br" });
    expect((full.contactPoint as { telephone: string }[])[0].telephone).toBe("+5591999990000");
    const minimal = buildOrganizationJsonLd({ name: "TRIVÉ", url: "https://x", logoUrl: "https://x/l.webp" });
    expect(minimal).not.toHaveProperty("email");
    expect(minimal).not.toHaveProperty("contactPoint");
  });

  it("WebSite com SearchAction apontando para a coleção", () => {
    const site = buildWebSiteJsonLd({ name: "TRIVÉ", url: "https://trivemaison.com.br" });
    expect(site).toMatchObject({
      "@type": "WebSite",
      potentialAction: { target: { urlTemplate: "https://trivemaison.com.br/produtos?q={search_term_string}" } },
    });
  });

  it("Product: menor preço, disponibilidade, material e imagens", () => {
    const product = buildProductJsonLd(
      {
        name: "Longo Dunas",
        slug: "longo-dunas",
        description: "  Linho.  ",
        composition: "100% linho",
        brand: "Aurora",
        imageUrls: ["https://x/a.webp"],
        variants: [
          { priceCents: 28900, availableQty: 0 },
          { priceCents: 25900, availableQty: 2 },
        ],
      },
      "https://trivemaison.com.br",
    );
    expect(product).toMatchObject({
      name: "Longo Dunas",
      url: "https://trivemaison.com.br/produto/longo-dunas",
      description: "Linho.",
      material: "100% linho",
      brand: { name: "Aurora" },
      offers: { price: "259.00", availability: "https://schema.org/InStock", priceCurrency: "BRL" },
    });
    const soldOut = buildProductJsonLd(
      { name: "X", slug: "x", description: null, brand: null, imageUrls: [], variants: [{ priceCents: 100, availableQty: 0 }] },
      "https://x",
    );
    expect((soldOut.offers as { availability: string }).availability).toBe("https://schema.org/OutOfStock");
    expect(soldOut).not.toHaveProperty("image");
    expect(buildProductJsonLd({ name: "X", slug: "x", description: null, brand: null, imageUrls: [], variants: [] }, "https://x")).not.toHaveProperty("offers");
  });

  it("serializa escapando '<' para nunca fechar a tag script", () => {
    expect(serializeJsonLd({ name: "<script>alert(1)</script>" })).not.toContain("<");
    expect(JSON.parse(serializeJsonLd({ name: "<b>" }))).toEqual({ name: "<b>" });
  });
});
