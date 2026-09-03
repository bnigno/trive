"use client";

// "O Véu" — abertura noir da home. A animação é 100% CSS (classes .veil-* em
// globals.css): roda antes do JS hidratar e termina em visibility:hidden, então
// o véu morre até sem JS. Aqui só há o mínimo de JS: pular por toque/tecla,
// lembrar que já foi visto (sessionStorage) e avisar o CSS que acabou
// (data-veil-done no <html>, que liga o brilho do wordmark). O elemento nunca é
// desmontado depois de tocar — a cascata do hero depende dele como irmão.
// Importa só React e as constantes de marca (assets.ts).
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { VEIL_SEEN_KEY } from "@/lib/brand";

import { BRAND } from "./brand/assets";

// Flag de módulo (browser): navegação SPA de volta à home não repete o véu.
// Nunca é mutada durante SSR (só dentro de useEffect) — sem hydration mismatch.
let played = false;

const MARK_WIDTH = 96;
const mark = BRAND.dark.mark;
const markLargest = mark[mark.length - 1];
const markHeight = Math.round(
  (MARK_WIDTH * markLargest.height) / markLargest.width,
);
const markSrcSet = mark
  .map((variant) => `${variant.src} ${variant.width}w`)
  .join(", ");
const markSrc = (
  mark.find((variant) => variant.width >= MARK_WIDTH * 2) ?? markLargest
).src;

// Fita em S (mesma curva de ribbon.tsx), desenhada pelo CSS do véu.
const RIBBON_WAVE = "M 2 12 C 40 -6, 80 30, 120 12 S 200 -6, 238 12";

function subscribeNoop() {
  return () => {};
}

function readSeen(): boolean {
  try {
    return sessionStorage.getItem(VEIL_SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberSeen() {
  try {
    sessionStorage.setItem(VEIL_SEEN_KEY, "1");
  } catch {
    // Safari privado / storage bloqueado: fica só a flag de módulo.
  }
}

function markVeilDone() {
  document.documentElement.setAttribute("data-veil-done", "");
}

export function BrandVeil() {
  // Servidor: false (renderiza o véu). Cliente: lê a sessão sem setState em
  // effect e sem mismatch — o <script> inline da home já escondeu o véu antes
  // do primeiro paint quando a sessão o conhece.
  const seen = useSyncExternalStore(subscribeNoop, readSeen, () => false);
  const [skipped, setSkipped] = useState(false);
  const [done] = useState(() => played);
  const endedRef = useRef(false);

  useEffect(() => {
    if (done || seen) {
      markVeilDone();
      return;
    }
    played = true;
    const onKey = () => {
      if (!endedRef.current) setSkipped(true);
    };
    window.addEventListener("keydown", onKey);
    // Fallback: se o animationend não disparar (aba em segundo plano etc.).
    const timer = window.setTimeout(finish, 2200);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(timer);
    };
  }, [done, seen]);

  function finish() {
    if (endedRef.current) return;
    endedRef.current = true;
    rememberSeen();
    markVeilDone();
  }

  if (done || seen) return null;

  return (
    // O contêiner recebe o toque de pular e NÃO é aria-hidden — só os visuais
    // internos são. Teclado: qualquer tecla pula (listener acima). Depois de
    // terminar (ou de pular) ele fica no DOM com visibility: hidden.
    <div
      className={skipped ? "veil veil-skip" : "veil"}
      role="presentation"
      onClick={() => {
        if (!endedRef.current) setSkipped(true);
      }}
      onAnimationEnd={(event) => {
        // Só a animação do próprio contêiner encerra o véu (as dos filhos
        // borbulham até aqui com target diferente).
        if (event.target === event.currentTarget) finish();
      }}
    >
      <div className="veil-inner" aria-hidden="true">
        <div className="veil-center">
          <div className="relative grid h-[min(62vw,340px)] w-[min(62vw,340px)] place-items-center">
            <img
              className="veil-mark h-auto w-[min(40vw,220px)]"
              src={markSrc}
              srcSet={markSrcSet}
              sizes="(min-width: 640px) 220px, 40vw"
              width={MARK_WIDTH}
              height={markHeight}
              alt=""
              decoding="async"
              draggable={false}
            />
            {/* Anel hairline se desenhando em volta da marca (o vetor não traz o círculo). */}
            <svg className="absolute inset-0 h-full w-full" viewBox="0 0 64 64">
              <circle
                className="veil-ring"
                cx="32"
                cy="32"
                r="26"
                fill="none"
                stroke="var(--color-gold-brush)"
                strokeWidth="0.35"
              />
            </svg>
          </div>
          <svg
            className="veil-ribbon w-40"
            viewBox="0 0 240 24"
            fill="none"
            aria-hidden="true"
          >
            <path
              d={RIBBON_WAVE}
              pathLength={1}
              stroke="var(--color-rose-200)"
              strokeWidth={2.5}
              strokeLinecap="round"
            />
            <path
              d={RIBBON_WAVE}
              pathLength={1}
              stroke="var(--color-gold-brush)"
              strokeWidth={0.8}
              strokeLinecap="round"
              transform="translate(0 5)"
            />
          </svg>
        </div>
        <p className="veil-hint font-store text-eyebrow uppercase text-ivory-300">
          Toque para entrar
        </p>
      </div>
    </div>
  );
}
