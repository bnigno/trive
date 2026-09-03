"use client";

// Centraliza o item ativo do trilho de categorias no celular, ajustando SÓ o
// scroller (nunca scrollIntoView, que rolaria a página inteira ao voltar pelo
// histórico). useLayoutEffect: antes do paint, para o trilho não pular com a
// página já em uso. Só React.
import { useLayoutEffect, useRef } from "react";

export function RailScroll({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const rail = ref.current;
    const active = rail?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!rail || !active) return;
    if (rail.scrollWidth <= rail.clientWidth) return;
    rail.scrollLeft = active.offsetLeft - (rail.clientWidth - active.offsetWidth) / 2;
  }, []);

  return (
    <div
      ref={ref}
      className="-mx-4 flex snap-x gap-x-6 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:gap-y-2 sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden"
    >
      {children}
    </div>
  );
}
