// O preview do link de story: título da peça, descrição pela nota da
// curadora (ou a descrição) e o cartão do post como og:image; sem peça, a
// maison; sempre noindex (a cortina é passagem, não página).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { curtainMetadata } from "@/app/ig/[slug]/curtain-metadata";
import type { CampaignCurtain } from "@/services/campaign-links";
import type { PublicProductDetail } from "@/services/store-catalog";

const PRODUCT: PublicProductDetail = {
  id: "p1",
  name: "Longo Dunas",
  slug: "longo-dunas",
  description: "Um longo de linho para o calor.",
  composition: null,
  careNotes: null,
  fitNotes: null,
  postCardPath: "cards/longo-dunas-post.webp",
  curatorNote: "Escolhi pelo caimento.",
  curatorAudioPath: null,
  curatorAudioMime: null,
  publicNow: true,
  brand: null,
  categoryName: null,
  categorySlug: null,
  attributesSchema: [],
  images: [{ path: "p1/foto-full.webp", color: null }],
  variants: [],
};

function curtain(over: Partial<CampaignCurtain> = {}): CampaignCurtain {
  return { slug: "dunas", label: "Dunas no story", isActive: true, product: PRODUCT, productPublicNow: true, sellerName: "Lia", plainWaUrl: "https://wa.me/55", ...over };
}

describe("curtainMetadata", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://x.supabase.co");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("com peça: título da peça, nota da curadora como descrição e o cartão do post como imagem", () => {
    const meta = curtainMetadata(curtain(), "TRIVÉ");
    expect(meta.title).toEqual({ absolute: "Longo Dunas · TRIVÉ" });
    expect(meta.description).toBe("Escolhi pelo caimento.");
    expect(meta.robots).toEqual({ index: false, follow: false });
    expect(meta.openGraph).toMatchObject({
      title: "Longo Dunas",
      images: [{ url: "https://x.supabase.co/storage/v1/object/public/product-images/cards/longo-dunas-post.webp", width: 1080, height: 1350 }],
    });
  });

  it("sem cartão cai na primeira foto; sem nota cai na descrição; sem nada, a frase da vendedora", () => {
    const semCartao = curtainMetadata(curtain({ product: { ...PRODUCT, postCardPath: null, curatorNote: null } }), "TRIVÉ");
    expect(semCartao.description).toBe("Um longo de linho para o calor.");
    expect(semCartao.openGraph).toMatchObject({ images: [{ url: "https://x.supabase.co/storage/v1/object/public/product-images/p1/foto-full.webp" }] });
    const semNada = curtainMetadata(curtain({ product: { ...PRODUCT, postCardPath: null, curatorNote: null, description: null, images: [] } }), "TRIVÉ");
    expect(semNada.description).toBe("Longo Dunas — fale com a Lia no WhatsApp.");
    expect((semNada.openGraph as { images?: unknown }).images).toBeUndefined();
  });

  it("sem peça: a maison e a vendedora; link inexistente: só o título de erro", () => {
    expect(curtainMetadata(curtain({ product: null, productPublicNow: false }), "TRIVÉ")).toMatchObject({
      title: { absolute: "TRIVÉ · Fale com a Lia" },
      description: "Toque para falar com a Lia no WhatsApp da TRIVÉ.",
      robots: { index: false, follow: false },
    });
    expect(curtainMetadata(null, "TRIVÉ")).toMatchObject({ title: "Link não encontrado", robots: { index: false, follow: false } });
  });
});
