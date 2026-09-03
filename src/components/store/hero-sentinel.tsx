"use client";

// Sensor da cortina. O hero é position: sticky e, por isso, fica sempre
// dentro do viewport durante a rolagem — um IntersectionObserver dentro dele
// nunca dispararia. O marcador é um pixel NO TOPO DE .day (fluxo normal, por
// cima do hero) com dois observers:
//   • rootMargin negativo da altura do header → data-tone="ivory" quando o
//     topo do dia passa sob a borda inferior do header (header volta ao marfim);
//   • sem rootMargin → data-hero="offstage" quando o dia cobre o hero inteiro
//     (animações pausam, conteúdo do hero some do compositor).
// Os atributos vão no próprio .cinema (closest), sem alcançar o layout.
// Importa só React.
import { useEffect, useRef } from "react";

function isPassed(entry: IntersectionObserverEntry): boolean {
  // Não intersecta E está acima do topo do viewport = já passou (não é o
  // estado inicial, em que o marcador está abaixo da dobra). Cobre bfcache e
  // scroll restaurado, porque o observer sempre reporta o estado atual.
  return !entry.isIntersecting && entry.boundingClientRect.top < 0;
}

export function HeroSentinel() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const marker = ref.current;
    const cinema = marker?.closest<HTMLElement>(".cinema");
    if (!marker || !cinema) return;
    if (typeof IntersectionObserver === "undefined") return;

    const header = document.querySelector<HTMLElement>(".site-header");
    const headerHeight = header?.offsetHeight ?? 56;

    const toneObserver = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        const passedHeader =
          !entry.isIntersecting && entry.boundingClientRect.top < headerHeight;
        if (passedHeader) cinema.setAttribute("data-tone", "ivory");
        else cinema.removeAttribute("data-tone");
      },
      { rootMargin: `-${headerHeight}px 0px 0px 0px`, threshold: 0 },
    );

    const stageObserver = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        if (isPassed(entry)) cinema.setAttribute("data-hero", "offstage");
        else cinema.removeAttribute("data-hero");
      },
      { threshold: 0 },
    );

    toneObserver.observe(marker);
    stageObserver.observe(marker);
    return () => {
      toneObserver.disconnect();
      stageObserver.disconnect();
      cinema.removeAttribute("data-tone");
      cinema.removeAttribute("data-hero");
    };
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none absolute top-0 left-0 h-px w-px"
    />
  );
}
