"use client";

// Dono da escolha de variação da página do produto: o seletor, a galeria e a
// barra fixa são irmãos e precisam concordar sobre cor e variante, então a
// escolha vive aqui e desce por props. A regra de "qual variante está
// escolhida" é pura (core/catalog/variant-selection). Tudo que é texto fixo
// (título, descrição) continua vindo pronto do Server Component pelas props
// `heading` e `children`.
import { trackStoreEvent } from "@/components/store/analytics";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { findColorAxis, imagesForColor } from "@/core/catalog/product-images";
import {
  findMatchedVariant,
  initialAxisSelection,
} from "@/core/catalog/variant-selection";
import { LiaLink } from "@/components/store/lia-link";
import { SameDayPromiseBadge } from "@/components/store/same-day-promise";
import type { PublicVariant } from "@/services/store-catalog";

import { sameDayPromiseAction } from "./actions";
import { BuyBar } from "./buy-bar";
import { ProductGallery, type GalleryImage } from "./gallery";
import { VariantPicker } from "./variant-picker";

export interface ProductDetailImage extends GalleryImage {
  /** Cor a que a foto pertence; null = foto do produto inteiro. */
  color: string | null;
}

export function ProductDetailClient({
  productName,
  slug,
  axes,
  variants,
  images,
  lia,
  heading,
  children,
}: {
  productName: string;
  slug: string;
  axes: string[];
  variants: PublicVariant[];
  images: ProductDetailImage[];
  /** "Falar com a Lia" com a variação escolhida; null = loja sem WhatsApp. */
  lia?: { sellerName: string; fallbackUrl: string | null } | null;
  heading: ReactNode;
  children?: ReactNode;
}) {
  const [selected, setSelected] = useState<Record<string, string>>(() =>
    initialAxisSelection(axes, variants),
  );
  // Peça vista: um evento por abertura da página (sem dado pessoal).
  useEffect(() => {
    trackStoreEvent("product_view", { slug });
  }, [slug]);
  const [buyBarVisible, setBuyBarVisible] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const colorAxis = findColorAxis(axes);
  const selectedColor = colorAxis ? (selected[colorAxis] ?? null) : null;
  const visibleImages = imagesForColor(images, selectedColor);
  const matched = findMatchedVariant(axes, variants, selected);
  const attributesLabel =
    axes.length > 0
      ? axes
          .map((axis) => selected[axis])
          .filter(Boolean)
          .join(" · ")
      : undefined;

  // A barra fixa aparece quando o marcador (logo após o botão principal) sai
  // por cima do viewport — não quando ainda está abaixo da dobra.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        setBuyBarVisible(!entry.isIntersecting && entry.boundingClientRect.top < 0);
      },
      { threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="grid gap-8 lg:grid-cols-2 lg:gap-12">
      <div className="self-start lg:sticky lg:top-24">
        {/* A key remonta a galeria ao trocar de cor: volta para a primeira foto
            daquela cor em vez de manter o slide que estava aberto. */}
        <ProductGallery
          key={selectedColor ?? ""}
          images={visibleImages}
          alt={selectedColor ? `${productName} — ${selectedColor}` : productName}
          initial={productName.trim().charAt(0).toUpperCase()}
        />
      </div>

      {/* min-w-0: a coluna não cresce com conteúdo largo (tabela de medidas rola dentro). */}
      <div className="flex min-w-0 flex-col gap-4">
        {heading}
        <VariantPicker
          productName={productName}
          slug={slug}
          imageUrl={visibleImages[0]?.thumb}
          axes={axes}
          variants={variants}
          selected={selected}
          matched={matched}
          onSelect={(axis, value) =>
            setSelected((previous) => ({ ...previous, [axis]: value }))
          }
        />
        <SameDayPromiseBadge weightGrams={matched?.weightGrams ?? null} quote={sameDayPromiseAction} />
        <div ref={sentinelRef} aria-hidden="true" className="h-px w-full" />
        {lia?.fallbackUrl ? (
          <div className="flex flex-col gap-1">
            <LiaLink
              source="pdp"
              sellerName={lia.sellerName}
              fallbackUrl={lia.fallbackUrl}
              productSlug={slug}
              variantSku={matched?.sku}
              className="w-full sm:w-auto"
            />
            <p className="font-store text-[13px] text-ink-500">
              Dúvida de tamanho, tecido ou prazo? A {lia.sellerName} responde no WhatsApp, já sabendo qual peça você está vendo.
            </p>
          </div>
        ) : null}
        {children}
      </div>

      <BuyBar
        visible={buyBarVisible}
        productName={productName}
        slug={slug}
        imageUrl={visibleImages[0]?.thumb}
        matched={matched}
        attributesLabel={attributesLabel}
      />
    </div>
  );
}
