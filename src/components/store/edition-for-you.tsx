"use client";
// Home: "A edição para você" — lê o token da cartela no navegador e pede ao
// servidor as três peças de hoje; sem cartela, convida para o quiz. A home
// continua estática (ISR): esta ilha só liga depois de montar.
import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";

import { SectionHeading } from "@/components/store/section-heading";
import { btnOutline } from "@/components/store/styles";
import { formatCentsBRL } from "@/lib/money";
import { readStoredStyle, storedStyleSnapshot, subscribeStoredStyle } from "@/lib/style-storage";

import { editionForTokenAction, type SavedStyleView } from "@/app/(store)/estilo/actions";

export function EditionForYou() {
  const storedRaw = useSyncExternalStore(subscribeStoredStyle, storedStyleSnapshot, () => "");
  const stored = storedRaw ? readStoredStyle() : null;
  const [view, setView] = useState<SavedStyleView | null>(null);

  useEffect(() => {
    if (!stored) return;
    let alive = true;
    editionForTokenAction(stored.token).then((result) => {
      if (alive) setView(result);
    });
    return () => {
      alive = false;
    };
  }, [stored?.token]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!stored) {
    return (
      <section aria-labelledby="edicao" className="py-12">
        <SectionHeading
          eyebrow="Espelho de estilo"
          title="A edição para você"
          id="edicao"
          aside={
            <Link href="/estilo" className={btnOutline}>
              Descobrir minha cartela
            </Link>
          }
        />
        <p className="max-w-2xl font-store text-base leading-relaxed text-ink-700">
          Em um minuto a TRIVÉ dá um nome à sua cartela — cores, caimento, tamanhos — e
          passa a escolher peças para você toda vez que a coleção muda.
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby="edicao" className="py-12">
      <SectionHeading
        eyebrow={`Sua cartela · ${view?.paletteName ?? stored.paletteName}`}
        title="A edição para você"
        id="edicao"
        aside={
          <Link href="/estilo" className="font-store text-sm tracking-[0.16em] text-ink-700 uppercase hover:text-gold-800">
            Ver a cartela
          </Link>
        }
      />
      {view === null ? (
        <p className="font-store text-sm text-ink-500">Escolhendo as peças de hoje…</p>
      ) : view.items.length === 0 ? (
        <p className="font-store text-sm text-ink-500">
          Nada novo bateu com a sua cartela hoje — a coleção muda toda semana.
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {view.items.map((item) => (
            <li key={item.slug}>
              <Link href={`/produto/${item.slug}`} className="group block overflow-hidden rounded-(--radius-hair) border border-ivory-300 bg-ivory-50">
                <div className="aspect-[3/4] w-full bg-ivory-200">
                  {item.imageUrl ? (
                    <img src={item.imageUrl} alt={item.name} className="h-full w-full object-cover transition-transform duration-500 ease-silk group-hover:scale-[1.02]" />
                  ) : null}
                </div>
              </Link>
              <p className="mt-2 font-display text-lg font-semibold text-espresso-900">{item.name}</p>
              <p className="font-store text-sm text-ink-700">
                {item.priceFromCents === item.priceToCents ? formatCentsBRL(item.priceFromCents) : `a partir de ${formatCentsBRL(item.priceFromCents)}`}
              </p>
              {item.reasons.length > 0 ? <p className="mt-1 font-store text-xs text-gold-800">{item.reasons.join(" · ")}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
