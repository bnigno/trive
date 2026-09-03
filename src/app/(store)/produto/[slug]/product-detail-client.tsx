"use client";

// Dono da escolha de variação da página do produto: o seletor, a galeria e a
// barra fixa são irmãos e precisam concordar sobre cor e variante, então a
// escolha vive aqui e desce por props. A regra de "qual variante está
// escolhida" é pura (core/catalog/variant-selection). Tudo que é texto fixo
// (título, descrição) continua vindo pronto do Server Component pelas props
// `heading` e `children`.
import { useEffect, useRef, useState, type ReactNode } from "react";

import { findColorAxis, imagesForColor } from "@/core/catalog/product-images";
import {
  findMatchedVariant,
  initialAxisSelection,
} from "@/core/catalog/variant-selection";
import type { PublicVariant } from "@/services/store-catalog";

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
  heading,
  children,
}: {
  productName: string;
  slug: string;
  axes: string[];
  variants: PublicVariant[];
  images: ProductDetailImage[];
  heading: ReactNode;
  children?: ReactNode;
}) {
  const [selected, setSelected] = useState<Record<string, string>>(() =>
    initialAxisSelection(axes, variants),
  );
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

      <div className="flex flex-col gap-4">
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
        <div ref={sentinelRef} aria-hidden="true" className="h-px w-full" />
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
