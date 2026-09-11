// Robots: vitrine indexável; admin, API e fluxos privados fora dos buscadores.
import type { MetadataRoute } from "next";

import { siteUrl } from "@/lib/site-url";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/admin", "/api", "/carrinho", "/checkout", "/pedido", "/lancamento"],
      },
    ],
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
