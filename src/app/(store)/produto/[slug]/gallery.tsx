"use client";

// Galeria do produto: imagem principal + miniaturas clicáveis.
// Client component leve — só troca o índice selecionado.
import { useState } from "react";

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
        className="flex aspect-square w-full items-center justify-center rounded-2xl bg-zinc-100 text-6xl text-zinc-300 dark:bg-zinc-800 dark:text-zinc-600"
      >
        ✦
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-800">
        {/* <img> simples de propósito: o otimizador da Vercel tem limites no
            plano gratuito — servimos os .webp direto do Supabase Storage. */}
        <img
          src={current.full}
          alt={alt}
          className="aspect-square w-full object-cover"
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
              className={cx(
                "h-16 w-16 shrink-0 overflow-hidden rounded-lg border-2 transition",
                index === selected
                  ? "border-amber-700"
                  : "border-transparent hover:border-zinc-300 dark:hover:border-zinc-600",
              )}
            >
              <img
                src={image.thumb}
                alt=""
                loading="lazy"
                className="h-full w-full object-cover"
              />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
