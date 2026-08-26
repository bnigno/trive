"use client";

// Dono da escolha de variação da página do produto: o seletor e a galeria são
// irmãos e precisam concordar sobre a cor, então a escolha vive aqui e desce
// por props para os dois. Tudo que é texto fixo (título, descrição) continua
// vindo pronto do Server Component pelas props `heading` e `children`.
import { useState, type ReactNode } from "react";

import { findColorAxis, imagesForColor } from "@/core/catalog/product-images";
import type { PublicVariant } from "@/services/store-catalog";

import { ProductGallery, type GalleryImage } from "./gallery";
import { initialAxisSelection, VariantPicker } from "./variant-picker";

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

  const colorAxis = findColorAxis(axes);
  const selectedColor = colorAxis ? (selected[colorAxis] ?? null) : null;
  const visibleImages = imagesForColor(images, selectedColor);

  return (
    <div className="grid gap-8 lg:grid-cols-2 lg:gap-12">
      <div className="self-start lg:sticky lg:top-24">
        {/* A key remonta a galeria ao trocar de cor: volta para a primeira foto
            daquela cor em vez de manter a miniatura que estava aberta. */}
        <ProductGallery
          key={selectedColor ?? ""}
          images={visibleImages}
          alt={selectedColor ? `${productName} — ${selectedColor}` : productName}
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
          onSelect={(axis, value) =>
            setSelected((previous) => ({ ...previous, [axis]: value }))
          }
        />
        {children}
      </div>
    </div>
  );
}
