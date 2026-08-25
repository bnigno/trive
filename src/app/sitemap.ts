// Sitemap da vitrine: home, listagem e cada página de produto público.
import type { MetadataRoute } from "next";

import { getDb } from "@/db/client";
import { tryOrBuildFallback } from "@/lib/build-safe";
import { listPublicProducts } from "@/services/store-catalog";

const BASE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"
).replace(/\/+$/, "");

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const products = await tryOrBuildFallback([], () =>
    listPublicProducts(getDb(), { limit: 200 }),
  );
  const now = new Date();

  return [
    { url: `${BASE_URL}/`, lastModified: now, changeFrequency: "daily" },
    {
      url: `${BASE_URL}/produtos`,
      lastModified: now,
      changeFrequency: "daily",
    },
    ...products.map((product) => ({
      url: `${BASE_URL}/produto/${product.slug}`,
      lastModified: now,
      changeFrequency: "weekly" as const,
    })),
  ];
}
