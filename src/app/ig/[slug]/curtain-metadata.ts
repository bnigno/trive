// O preview do link de story (og:image, título e descrição): a peça quando
// há, senão a maison. Puro, fora do page.tsx (que só exporta o que o Next
// permite) para o teste cobrir sem banco.
import type { Metadata } from "next";

import type { CampaignCurtain } from "@/services/campaign-links";
import { publicImageUrl } from "@/services/store-catalog";

/** Título, descrição e imagem do preview: a peça quando há, senão a maison. */
export function curtainMetadata(curtain: CampaignCurtain | null, storeName: string): Metadata {
  const noIndex = { robots: { index: false, follow: false } } as const;
  if (!curtain) return { title: "Link não encontrado", ...noIndex };
  const product = curtain.product;
  if (!product) {
    return {
      title: { absolute: `${storeName} · Fale com a ${curtain.sellerName}` },
      description: `Toque para falar com a ${curtain.sellerName} no WhatsApp da ${storeName}.`,
      ...noIndex,
    };
  }
  const description =
    product.curatorNote?.trim().slice(0, 160) ||
    product.description?.trim().slice(0, 160) ||
    `${product.name} — fale com a ${curtain.sellerName} no WhatsApp.`;
  const image = product.postCardPath
    ? { url: publicImageUrl(product.postCardPath), alt: product.name, width: 1080, height: 1350 }
    : product.images[0]
      ? { url: publicImageUrl(product.images[0].path), alt: product.name }
      : null;
  return {
    title: { absolute: `${product.name} · ${storeName}` },
    description,
    ...noIndex,
    openGraph: {
      title: product.name,
      description,
      type: "website",
      ...(image ? { images: [image] } : {}),
    },
  };
}

