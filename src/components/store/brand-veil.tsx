"use client";

// "O Véu da maison" — abertura da vitrine, montada só na home.
// A animação é 100% CSS (classes .veil-* em globals.css): roda antes do JS
// hidratar e o keyframe final do contêiner seta visibility:hidden, então o
// véu morre até sem JS. Aqui só há o mínimo de JS: pular por clique/tecla e
// desmontar no fim. Importa só React (regra do plano).
import { useEffect, useState } from "react";

// Flag de módulo (browser): navegação SPA de volta à home não repete o véu.
// Nunca é mutada durante SSR (só dentro de useEffect) — sem hydration mismatch.
let played = false;

// Réplica do desenho de brand/monogram.tsx (o véu não pode importá-lo — só
// React). Na troca pelo logo real, atualizar aqui também.
const T_PATH =
  "M 20.2 24.6 L 43.8 24.6 L 43.8 30.2 C 43.3 27.9 42.4 27.1 39.8 27 " +
  "L 34.3 27 L 34.3 42.4 C 34.3 44.3 35.2 44.8 38.1 45 L 38.1 45.9 " +
  "L 25.9 45.9 L 25.9 45 C 28.8 44.8 29.7 44.3 29.7 42.4 L 29.7 27 " +
  "L 24.2 27 C 21.6 27.1 20.7 27.9 20.2 30.2 Z";

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
          <svg viewBox="0 0 64 64" width={88} height={88}>
            <g className="veil-mark">
              <circle cx="32" cy="32" r="31" fill="var(--color-ink-950)" />
              <path d={T_PATH} fill="var(--color-gold-400)" />
              <circle cx="28.8" cy="20.8" r="1.5" fill="var(--color-gold-400)" />
              <circle cx="35.2" cy="20.8" r="1.5" fill="var(--color-gold-400)" />
            </g>
            <circle
              className="veil-ring"
              cx="32"
              cy="32"
              r="26"
              fill="none"
              stroke="var(--color-gold-500)"
              strokeWidth="1"
            />
          </svg>
          <p className="veil-hint font-store text-eyebrow uppercase text-ink-500">
            Toque para entrar
          </p>
        </div>
      </div>
    </div>
  );
}
