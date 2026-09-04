// As páginas legais como documento da maison: capa (eyebrow, título em
// display, lide itálica, fita), índice numerado (2 colunas no celular, grudado
// no desktop) e seções com filete dourado + numeral. Server Components.
import type { ReactNode } from "react";

import { Ornament } from "@/components/store/ornament";
import { Ribbon } from "@/components/store/ribbon";
import { eyebrow as eyebrowClass, numeral } from "@/components/store/styles";

export interface LegalTocItem {
  id: string;
  title: string;
}

export function LegalArticle({
  eyebrow,
  title,
  lede,
  toc,
  children,
}: {
  eyebrow: string;
  title: string;
  lede: ReactNode;
  toc: LegalTocItem[];
  children: ReactNode;
}) {
  return (
    <article className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
      <header className="flex flex-col items-start gap-3">
        <p className={eyebrowClass}>{eyebrow}</p>
        <h1 className="font-display text-display font-semibold text-balance text-espresso-900">
          {title}
        </h1>
        <p className="max-w-2xl font-display text-xl leading-relaxed text-ink-700 italic">
          {lede}
        </p>
        <Ribbon variant="enter" size="sm" />
      </header>

      <div className="mt-10 lg:grid lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-x-16">
        <nav
          aria-label="Neste documento"
          className="lg:sticky lg:top-[calc(var(--header-h)+1.5rem)] lg:self-start"
        >
          <ol className="grid grid-cols-2 gap-x-6 lg:grid-cols-1">
            {toc.map((item, index) => (
              <li key={item.id}>
                <a
                  href={`#${item.id}`}
                  className="group flex min-h-11 items-baseline gap-3 py-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600"
                >
                  <span className={numeral}>
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="font-store text-sm leading-snug text-ink-700 transition-colors duration-300 group-hover:text-gold-800">
                    {item.title}
                  </span>
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="mt-10 max-w-2xl lg:mt-0">
          {children}
          <footer className="mt-14 flex flex-col items-center gap-3 text-center">
            <Ornament className="text-gold-500" />
            <p className="font-store text-sm text-ink-500">
              Atualizado sempre que algo muda; vale a versão publicada aqui.
            </p>
          </footer>
        </div>
      </div>
    </article>
  );
}

export function LegalSection({
  id,
  number,
  title,
  children,
}: {
  id: string;
  number: string;
  title: string;
  children: ReactNode;
}) {
  const headingId = `${id}-titulo`;
  return (
    <section id={id} aria-labelledby={headingId} className="mt-12 first:mt-0">
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className="h-px w-10 bg-gold-500" />
        <span className={numeral}>{number}</span>
      </div>
      <h2
        id={headingId}
        className="mt-3 font-display text-heading font-semibold text-espresso-900"
      >
        {title}
      </h2>
      <div className="mt-3 space-y-3 font-store text-[15px] leading-7 text-ink-700 marker:text-gold-800 lg:text-base lg:leading-8">
        {children}
      </div>
    </section>
  );
}
