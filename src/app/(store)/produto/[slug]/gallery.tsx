"use client";

// Galeria do produto: uma faixa com rolagem e "snap" (um slide por foto) em
// todas as telas, pontos para navegar e, no desktop, miniaturas. O índice ativo
// vem de um IntersectionObserver no próprio scroller (sem listener de scroll).
// Remontada pela cor escolhida (key no componente pai) — volta à 1ª foto.
import { useEffect, useRef, useState } from "react";

import { Ribbon } from "@/components/store/ribbon";
import { cx } from "@/components/ui/cx";

export interface GalleryImage {
  /** URL pública da imagem cheia (1600w). */
  full: string;
  /** URL pública da rendição média (800w). */
  md: string;
  /** URL pública do thumbnail (400w). */
  thumb: string;
}

const SIZES = "(min-width: 1024px) 50vw, 100vw";

function srcSetOf(image: GalleryImage): string {
  return `${image.thumb} 400w, ${image.md} 800w, ${image.full} 1600w`;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function ProductGallery({
  images,
  alt,
  initial,
}: {
  images: GalleryImage[];
  alt: string;
  /** Letra da etiqueta de ateliê quando não há foto. */
  initial: string;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
            const index = Number((entry.target as HTMLElement).dataset.index);
            if (!Number.isNaN(index)) setSelected(index);
          }
        }
      },
      { root: scroller, threshold: 0.6 },
    );
    for (const slide of scroller.querySelectorAll("[data-index]")) {
      observer.observe(slide);
    }
    return () => observer.disconnect();
  }, [images]);

  function goTo(index: number) {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scroller.scrollTo({
      left: scroller.clientWidth * index,
      behavior: prefersReducedMotion() ? "instant" : "smooth",
    });
  }

  if (images.length === 0) {
    return (
      <div
        aria-hidden="true"
        className="relative flex aspect-(--aspect-product) w-full items-center justify-center overflow-hidden rounded-(--radius-hair) border border-ivory-300 bg-ivory-150"
      >
        <Ribbon
          variant="static"
          size="md"
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 opacity-25"
        />
        <span className="relative font-display text-[8rem] leading-none font-semibold text-ivory-400 select-none">
          {initial}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="relative overflow-hidden rounded-(--radius-hair) border border-ivory-300 bg-ivory-150">
        {/* Cantoneiras douradas (decorativas) */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-2 left-2 z-10 h-3.5 w-3.5 border-t border-l border-gold-500/70"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-2 bottom-2 z-10 h-3.5 w-3.5 border-r border-b border-gold-500/70"
        />
        <div
          ref={scrollerRef}
          role="group"
          aria-roledescription="carrossel"
          aria-label="Fotos do produto"
          className="flex snap-x snap-mandatory overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {images.map((image, index) => (
            <div
              key={image.full}
              data-index={index}
              role="group"
              aria-roledescription="slide"
              aria-label={`${index + 1} de ${images.length}`}
              className="w-full shrink-0 snap-center"
            >
              {/* <img> simples de propósito: os .webp já vêm redimensionados do
                  Storage e o otimizador da Vercel tem limites no plano atual. */}
              <img
                src={image.md}
                srcSet={srcSetOf(image)}
                sizes={SIZES}
                alt={index === 0 ? alt : `${alt} — foto ${index + 1}`}
                width={800}
                height={800}
                decoding={index === 0 ? "sync" : "async"}
                loading={index === 0 ? undefined : "lazy"}
                fetchPriority={index === 0 ? "high" : "low"}
                draggable={false}
                className="aspect-(--aspect-product) w-full object-cover"
              />
            </div>
          ))}
        </div>
      </div>

      {images.length > 1 ? (
        <>
          <div
            role="group"
            aria-label="Ir para a foto"
            className="flex items-center justify-center lg:hidden"
          >
            {images.map((image, index) => (
              <button
                key={image.thumb + index}
                type="button"
                onClick={() => goTo(index)}
                aria-label={`Ver foto ${index + 1} de ${images.length}`}
                aria-current={index === selected ? "true" : undefined}
                className="flex h-11 w-11 items-center justify-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600"
              >
                <span
                  aria-hidden="true"
                  className={cx(
                    "block h-1.5 w-1.5 rounded-full transition-colors duration-300",
                    index === selected ? "bg-gold-700" : "bg-ivory-400",
                  )}
                />
              </button>
            ))}
          </div>

          <div
            role="group"
            aria-label="Miniaturas do produto"
            className="hidden gap-2 overflow-x-auto pb-1 lg:flex"
          >
            {images.map((image, index) => (
              <button
                key={image.thumb + index}
                type="button"
                onClick={() => goTo(index)}
                aria-label={`Ver foto ${index + 1} de ${images.length}`}
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
                    width={64}
                    height={64}
                    loading="lazy"
                    decoding="async"
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
        </>
      ) : null}
    </div>
  );
}
