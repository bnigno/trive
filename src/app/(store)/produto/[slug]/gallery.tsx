"use client";

// Galeria do produto: imagem principal + miniaturas clicáveis.
// Client component leve — só troca o índice selecionado; o crossfade vem do
// remount da imagem (key) com o keyframe gallery-in do globals.
import { useState } from "react";

import { Monogram } from "@/components/store/brand/monogram";
import { cx } from "@/components/ui/cx";

export interface GalleryImage {
  /** URL pública da imagem cheia. */
  full: string;
  /** URL pública do thumbnail. */
  thumb: string;
}

export function ProductGallery({
  images,
  alt,
}: {
  images: GalleryImage[];
  alt: string;
}) {
  const [selected, setSelected] = useState(0);
  const current = images[selected] ?? images[0];

  if (!current) {
    return (
      <div
        aria-hidden="true"
        className="flex aspect-square w-full items-center justify-center rounded-(--radius-hair) border border-ivory-300 bg-ivory-200"
      >
        <Monogram size={72} className="opacity-15" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-(--radius-hair) border border-ivory-300 bg-ivory-200">
        {/* <img> simples de propósito: o otimizador da Vercel tem limites no
            plano gratuito — servimos os .webp direto do Supabase Storage. */}
        <img
          key={current.full}
          src={current.full}
          alt={alt}
          className="aspect-square w-full animate-gallery-in object-cover"
        />
      </div>
      {images.length > 1 ? (
        <div
          role="group"
          aria-label="Miniaturas do produto"
          className="flex gap-2 overflow-x-auto pb-1"
        >
          {images.map((image, index) => (
            <button
              key={image.thumb + index}
              type="button"
              onClick={() => setSelected(index)}
              aria-label={`Ver imagem ${index + 1} de ${images.length}`}
              aria-pressed={index === selected}
              className="flex w-16 shrink-0 flex-col gap-1.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600"
            >
              <span
                className={cx(
                  "block h-16 w-16 overflow-hidden rounded-(--radius-soft) transition-opacity duration-300 ease-silk",
                  index === selected
                    ? "opacity-100"
                    : "opacity-70 hover:opacity-100",
                )}
              >
                <img
                  src={image.thumb}
                  alt=""
                  loading="lazy"
                  className="h-full w-full object-cover"
                />
              </span>
              <span
                aria-hidden="true"
                className={cx(
                  "h-px w-full",
                  index === selected ? "bg-gold-500" : "bg-transparent",
                )}
              />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
