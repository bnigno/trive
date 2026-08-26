"use client";

// <Reveal> — entrada suave ao rolar. Conteúdo VISÍVEL por padrão no SSR
// (zero flash sem JS); no mount, só elementos com o topo abaixo do viewport
// recebem data-reveal="pending" (CSS em globals.css) e entram num
// IntersectionObserver singleton de módulo. Reduced motion = passthrough.
// Importa só React (regra do plano).
import { useEffect, useLayoutEffect, useRef } from "react";

// No servidor o useLayoutEffect não roda (e o React avisa) — troca por
// useEffect lá; no browser mantém o layout effect para esconder antes do paint.
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

let observer: IntersectionObserver | null = null;

function observe(element: Element) {
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.removeAttribute("data-reveal");
          observer?.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.15, rootMargin: "0px 0px -10% 0px" },
  );
  observer.observe(element);
}

export function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useIsomorphicLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // Já visível (ou acima do fold): fica como está — sem flash.
    if (element.getBoundingClientRect().top <= window.innerHeight) return;
    element.setAttribute("data-reveal", "pending");
    observe(element);
    return () => {
      observer?.unobserve(element);
      element.removeAttribute("data-reveal");
    };
  }, []);

  return (
    <div
      ref={ref}
      className={className ? `reveal ${className}` : "reveal"}
      style={delay > 0 ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  );
}
