// Sitemap da vitrine: home, coleção e salas, cada peça pública, cartela e
// páginas legais. Sacola, checkout, pedido e lançamentos ficam de fora (são
// privados ou por token).
import type { MetadataRoute } from "next";

import { getDb } from "@/db/client";
import { tryOrBuildFallback } from "@/lib/build-safe";
import { siteUrl } from "@/lib/site-url";
import { getUpcomingDropTeaser } from "@/services/drops";
import { listPublicCategories, listPublicProducts } from "@/services/store-catalog";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();
  const [products, categories, teaser] = await Promise.all([
    tryOrBuildFallback([], () => listPublicProducts(getDb(), { limit: 200 })),
    tryOrBuildFallback([], () => listPublicCategories(getDb())),
    tryOrBuildFallback(null, () => getUpcomingDropTeaser(getDb())),
  ]);
  const now = new Date();

  return [
    { url: `${base}/`, lastModified: now, changeFrequency: "daily", priority: 1 },
    { url: `${base}/produtos`, lastModified: now, changeFrequency: "daily", priority: 0.9 },
    ...categories
      .filter((category) => category.productCount > 0)
      .map((category) => ({
        url: `${base}/produtos?categoria=${encodeURIComponent(category.slug)}`,
        lastModified: now,
        changeFrequency: "daily" as const,
        priority: 0.8,
      })),
    ...products.map((product) => ({
      url: `${base}/produto/${product.slug}`,
      lastModified: product.updatedAt ?? now,
      changeFrequency: "weekly" as const,
      priority: 0.7,
    })),
    // /estreia só entra em cartaz (teaser ou aberta há menos de um dia).
    ...(teaser ? [{ url: `${base}/estreia`, lastModified: now, changeFrequency: "hourly" as const, priority: 0.8 }] : []),
    { url: `${base}/estilo`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
    { url: `${base}/trocas-e-devolucoes`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${base}/termos`, lastModified: now, changeFrequency: "yearly", priority: 0.2 },
    { url: `${base}/privacidade`, lastModified: now, changeFrequency: "yearly", priority: 0.2 },
  ];
}
