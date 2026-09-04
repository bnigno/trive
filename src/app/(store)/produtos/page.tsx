// A coleção como "a edição": capa tipográfica (ou a foto da sala), sumário
// numerado no desktop, busca (#busca, alvo da lupa do header no celular),
// cabeço de salas fixo abaixo do header e a grade editorial com ritmo 7/5.
// A rota lê searchParams, então o Next a renderiza sob demanda — sem
// force-dynamic. A página só busca e apresenta; a malha vive em lib/.
import type { Metadata } from "next";
import Link from "next/link";

import { CategoryCover } from "@/components/store/category-cover";
import { CategoryIndex } from "@/components/store/category-index";
import { EditorialGrid } from "@/components/store/editorial-grid";
import { EmptyState } from "@/components/store/empty-state";
import { IconSearch } from "@/components/store/icons";
import { RailScroll } from "@/components/store/rail-scroll";
import { Ribbon } from "@/components/store/ribbon";
import {
  btnOutline,
  btnSmallDark,
  eyebrow,
  inputBase,
} from "@/components/store/styles";
import { cx } from "@/components/ui/cx";
import { getDb } from "@/db/client";
import { arrangeEdition } from "@/lib/editorial-rhythm";
import {
  listPublicCategories,
  listPublicProducts,
} from "@/services/store-catalog";

export const metadata: Metadata = {
  title: "A coleção",
  description: "Todas as peças da maison, por sala ou por busca.",
};

const PAGE_LIMIT = 60;

function chipHref(categoria: string | null, q: string): string {
  const params = new URLSearchParams();
  if (categoria) params.set("categoria", categoria);
  if (q) params.set("q", q);
  const query = params.toString();
  return query ? `/produtos?${query}` : "/produtos";
}

const chip =
  "inline-flex min-h-11 shrink-0 snap-center items-center border-b-2 font-store text-xs tracking-[0.18em] whitespace-nowrap uppercase transition-colors duration-300 ease-silk focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600";
const chipActive = "border-gold-700 text-espresso-900";
const chipIdle = "border-transparent text-ink-500 hover:text-ink-900";

function countLabel(count: number): string {
  return count === 1 ? "1 peça" : `${count} peças`;
}

export default async function ProdutosPage({
  searchParams,
}: {
  searchParams: Promise<{ categoria?: string; q?: string }>;
}) {
  const params = await searchParams;
  const categoria = (params.categoria ?? "").trim();
  const q = (params.q ?? "").trim();

  const db = getDb();
  const [found, categories] = await Promise.all([
    listPublicProducts(db, {
      categorySlug: categoria || undefined,
      q: q || undefined,
      limit: PAGE_LIMIT,
    }),
    listPublicCategories(db),
  ]);

  // As capas do primeiro ciclo ganham peças com foto; a primeira delas
  // carrega com prioridade quando está acima da dobra (índice 0 ou 1).
  const products = arrangeEdition(found);
  const firstWithPhoto = products.findIndex((product) => product.imagePath);
  const priorityIndex = firstWithPhoto >= 0 && firstWithPhoto < 2 ? firstWithPhoto : -1;

  const activeCategory = categories.find((c) => c.slug === categoria) ?? null;
  const isSearch = q !== "";
  const count = countLabel(products.length);
  const eyebrowText = isSearch
    ? `Busca · ${count}`
    : activeCategory
      ? `Sala · ${count}`
      : `A edição · ${count}`;
  const title = isSearch
    ? `Resultados para “${q}”`
    : (activeCategory?.name ?? "A coleção");
  // A fita só se desenha na capa da edição inteira: nas salas e buscas a
  // página remonta a cada clique e a animação viraria tique.
  const ribbonVariant = !categoria && !isSearch ? "enter" : "static";
  const showCover = Boolean(activeCategory?.coverPath) && !isSearch;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      {/* 1. Capa da edição */}
      {showCover && activeCategory ? (
        <CategoryCover
          category={activeCategory}
          size="edition"
          sizes="(min-width: 1152px) 1104px, 100vw"
          className="mb-6 sm:mb-8"
        />
      ) : null}

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-end lg:gap-x-16">
        <header className="flex flex-col items-start gap-3">
          <p className={eyebrow}>{eyebrowText}</p>
          <h1
            className={cx(
              "font-display font-semibold text-balance text-espresso-900",
              isSearch
                ? "text-title"
                : "text-display lg:text-[5.25rem] lg:leading-[0.95]",
            )}
          >
            {title}
          </h1>
          <Ribbon variant={ribbonVariant} size="sm" />
          {isSearch ? (
            <Link
              href={chipHref(categoria || null, "")}
              className="inline-flex min-h-11 items-center font-store text-xs tracking-[0.16em] text-ink-700 uppercase underline decoration-gold-500 underline-offset-4 transition-colors hover:text-gold-800"
            >
              Limpar busca
            </Link>
          ) : null}
        </header>

        {/* 2. Sumário (desktop) + busca */}
        <aside className="mt-6 lg:mt-0">
          {categories.length > 0 ? (
            <div className="hidden lg:block">
              <p className={cx(eyebrow, "mb-1")}>Sumário</p>
              <CategoryIndex
                categories={categories}
                activeSlug={activeCategory?.slug ?? null}
                includeAll
                ariaLabel="Sumário da edição"
                compact
                className="[&>ol]:mx-0 [&>ol]:max-w-none"
              />
            </div>
          ) : null}
          <form
            action="/produtos"
            method="GET"
            role="search"
            className="flex max-w-md items-end gap-3 lg:mt-6"
          >
            <label htmlFor="busca" className="sr-only">
              Procurar uma peça
            </label>
            <div className="relative min-w-0 flex-1">
              <IconSearch className="pointer-events-none absolute top-1/2 left-0 h-4 w-4 -translate-y-1/2 text-ink-500" />
              <input
                id="busca"
                type="search"
                name="q"
                defaultValue={q}
                placeholder="Procurar uma peça…"
                className={cx(inputBase, "min-h-11 pl-6")}
              />
              {categoria ? (
                <input type="hidden" name="categoria" value={categoria} />
              ) : null}
            </div>
            <button type="submit" className={btnSmallDark}>
              Buscar
            </button>
          </form>
        </aside>
      </div>

      {/* 3. Cabeço corrente: salas + contagem */}
      {categories.length > 0 ? (
        <nav
          aria-label="Salas da maison"
          className="sticky top-(--header-h) z-30 mt-8 border-b border-ivory-300 bg-ivory-100/95 py-1 lg:backdrop-blur"
        >
          <div className="lg:flex lg:items-center lg:justify-between lg:gap-6">
            <div className="min-w-0 flex-1">
              <RailScroll>
                <Link
                  href={chipHref(null, q)}
                  className={cx(chip, categoria ? chipIdle : chipActive)}
                  aria-current={categoria ? undefined : "page"}
                >
                  Todas
                </Link>
                {categories.map((category) => (
                  <Link
                    key={category.id}
                    href={chipHref(category.slug, q)}
                    className={cx(
                      chip,
                      category.slug === categoria ? chipActive : chipIdle,
                    )}
                    aria-current={category.slug === categoria ? "page" : undefined}
                  >
                    {category.name}
                  </Link>
                ))}
              </RailScroll>
            </div>
            <p className={cx(eyebrow, "hidden shrink-0 lg:block")}>{count}</p>
          </div>
        </nav>
      ) : null}

      {/* 4. As peças */}
      {products.length === 0 ? (
        <div className="mt-10">
          <EmptyState
            title={
              isSearch
                ? "Nenhuma peça atende a essa busca"
                : "Esta sala está sendo arrumada"
            }
            hint={
              isSearch
                ? "Tente outra palavra ou passeie pelas salas."
                : "Enquanto isso, a coleção inteira está aberta."
            }
            action={
              <Link href="/produtos" className={btnOutline}>
                Ver toda a coleção
              </Link>
            }
          >
            <CategoryIndex
              categories={categories}
              compact
              ariaLabel="Índice das salas"
            />
          </EmptyState>
        </div>
      ) : (
        // h2 invisível: os cards são h3 e a ordem de títulos (h1 → h2 → h3)
        // é o que leitores de tela e o Lighthouse esperam.
        <section aria-labelledby="pecas" className="mt-10 lg:mt-14">
          <h2 id="pecas" className="sr-only">
            Peças
          </h2>
          <EditorialGrid products={products} priorityIndex={priorityIndex} />
          {products.length === PAGE_LIMIT ? (
            <p className="mt-12 text-center font-store text-sm text-ink-500">
              Mostrando as {PAGE_LIMIT} peças mais recentes. Use a busca ou as
              salas para chegar às outras.
            </p>
          ) : null}
        </section>
      )}
    </div>
  );
}
