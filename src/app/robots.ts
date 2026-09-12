// Robots: vitrine indexável; admin, API e fluxos privados fora dos buscadores.
import type { MetadataRoute } from "next";

import { siteUrl } from "@/lib/site-url";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // /ig são as cortinas dos links de story: passagem para o WhatsApp, não página.
        disallow: ["/admin", "/api", "/carrinho", "/checkout", "/pedido", "/lancamento", "/ig"],
      },
    ],
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
