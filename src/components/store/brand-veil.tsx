"use client";

// "O Véu da maison" — abertura da vitrine, montada só na home.
// A animação é 100% CSS (classes .veil-* em globals.css): roda antes do JS
// hidratar e o keyframe final do contêiner seta visibility:hidden, então o
// véu morre até sem JS. Aqui só há o mínimo de JS: pular por clique/tecla e
// desmontar no fim. Importa só React e as constantes de marca (assets.ts).
import { useEffect, useState } from "react";

import { BRAND } from "./brand/assets";

// Flag de módulo (browser): navegação SPA de volta à home não repete o véu.
// Nunca é mutada durante SSR (só dentro de useEffect) — sem hydration mismatch.
let played = false;

const MARK_WIDTH = 72;
const mark = BRAND.light.mark;
const markLargest = mark[mark.length - 1];
const markHeight = Math.round((MARK_WIDTH * markLargest.height) / markLargest.width);
const markSrcSet = mark
  .map((variant) => `${variant.src} ${variant.width}w`)
  .join(", ");

export function BrandVeil() {
  const [skipped, setSkipped] = useState(false);
  const [done, setDone] = useState(() => played);

  useEffect(() => {
    if (done) return;
    played = true;
    const onKey = () => setSkipped(true);
    window.addEventListener("keydown", onKey);
    // Fallback: se o animationend não disparar (aba em segundo plano etc.).
    const timer = window.setTimeout(() => setDone(true), 1800);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(timer);
    };
  }, [done]);

  if (done) return null;

  return (
    // O contêiner recebe o clique de pular e NÃO é aria-hidden — só os
    // visuais internos são. Teclado: qualquer tecla pula (listener acima).
    <div
      className={skipped ? "veil veil-skip" : "veil"}
      role="presentation"
      onClick={() => setSkipped(true)}
      onAnimationEnd={(event) => {
        // Só a animação do próprio contêiner encerra o véu (as dos filhos
        // borbulham até aqui com target diferente).
        if (event.target === event.currentTarget) setDone(true);
      }}
    >
      <div className="veil-inner" aria-hidden="true">
        <div className="veil-panel veil-panel-top" />
        <div className="veil-panel veil-panel-bottom" />
        <div className="veil-seam" />
        <div className="veil-center">
          <div className="relative grid h-[120px] w-[120px] place-items-center">
            <img
              className="veil-mark"
              src={(mark.find((variant) => variant.width >= MARK_WIDTH * 2) ?? markLargest).src}
              srcSet={markSrcSet}
              sizes={`${MARK_WIDTH}px`}
              width={MARK_WIDTH}
              height={markHeight}
              alt=""
              decoding="async"
              draggable={false}
            />
            {/* Anel hairline se desenhando em volta da marca (o vetor não traz o círculo). */}
            <svg
              className="absolute inset-0"
              viewBox="0 0 64 64"
              width={120}
              height={120}
            >
              <circle
                className="veil-ring"
                cx="32"
                cy="32"
                r="26"
                fill="none"
                stroke="var(--color-gold-500)"
                strokeWidth="0.6"
              />
            </svg>
          </div>
          <p className="veil-hint font-store text-eyebrow uppercase text-ink-500">
            Toque para entrar
          </p>
        </div>
      </div>
    </div>
  );
}
