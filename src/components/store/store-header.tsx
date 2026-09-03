// Header da vitrine: uma linha de 56px em todas as telas — marca, "Coleção"
// (e "Início" a partir de sm), busca (inline no desktop; no celular a lupa
// leva ao campo #busca de /produtos) e sacola. Sobre o hero da home fica noir
// e transparente pela variante noir: (ver @custom-variant em globals.css); as
// duas versões da marca ficam no DOM e o CSS mostra uma. Server Component.
import Link from "next/link";

import { Monogram } from "@/components/store/brand/monogram";
import { Wordmark } from "@/components/store/brand/wordmark";
import { CartButton } from "@/components/store/cart/cart-button";
import { IconSearch } from "@/components/store/icons";
import { cx } from "@/components/ui/cx";

const navLink =
  "inline-flex min-h-11 items-center border-b border-transparent font-store text-eyebrow font-medium uppercase tracking-[0.22em] text-ink-700 transition-colors duration-300 hover:border-gold-500 hover:text-ink-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600 noir:text-ivory-200 noir:hover:border-gold-brush noir:hover:text-ivory-50 noir:focus-visible:outline-gold-200";

const iconButton =
  "inline-flex h-11 w-11 items-center justify-center rounded-full text-ink-800 transition-colors duration-300 hover:bg-ivory-200 hover:text-ink-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600 noir:text-ivory-200 noir:hover:bg-ivory-50/10 noir:hover:text-ivory-50 noir:focus-visible:outline-gold-200";

export function StoreHeader({ storeName }: { storeName: string }) {
  return (
    <header
      className="site-header sticky top-0 z-40 h-(--header-h) border-b border-ivory-300 bg-ivory-50 transition-[background-color] duration-300 lg:bg-ivory-50/90 lg:backdrop-blur noir:border-transparent noir:bg-transparent noir:backdrop-blur-none"
      style={{
        paddingLeft: "env(safe-area-inset-left)",
        paddingRight: "env(safe-area-inset-right)",
      }}
    >
      <div className="mx-auto flex h-full max-w-6xl items-center gap-3 px-4 sm:gap-6 sm:px-6">
        <Link
          href="/"
          aria-label={`${storeName} — início`}
          className="flex min-h-11 items-center gap-2.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600 noir:focus-visible:outline-gold-200"
        >
          <Monogram size={30} className="logo-light noir:hidden" />
          <Monogram
            size={30}
            tone="gold"
            lazy
            className="logo-dark hidden noir:block"
          />
          <Wordmark className="text-base text-espresso-900 sm:text-lg noir:text-ivory-100">
            {storeName}
          </Wordmark>
        </Link>

        <nav
          aria-label="Principal"
          className="ml-1 flex items-center gap-4 sm:ml-6 sm:gap-6"
        >
          <Link href="/" className={cx(navLink, "hidden sm:inline-flex")}>
            Início
          </Link>
          <Link href="/produtos" className={navLink}>
            Coleção
          </Link>
        </nav>

        <div className="ml-auto flex items-center gap-1 sm:gap-3">
          <form
            action="/produtos"
            method="GET"
            role="search"
            className="hidden sm:block"
          >
            <label htmlFor="store-search" className="sr-only">
              Buscar na coleção
            </label>
            <div className="relative sm:w-56">
              <IconSearch className="pointer-events-none absolute top-1/2 left-0 h-4 w-4 -translate-y-1/2 text-ink-400 noir:text-ivory-300" />
              <input
                id="store-search"
                type="search"
                name="q"
                placeholder="Buscar na coleção…"
                className="w-full appearance-none rounded-none border-0 border-b border-ivory-300 bg-transparent py-2 pr-1 pl-6 font-store text-sm text-ink-900 transition-colors duration-300 placeholder:text-ink-400 focus:border-gold-600 focus:outline-none noir:border-ivory-50/30 noir:text-ivory-100 noir:placeholder:text-ivory-300 noir:focus:border-gold-brush"
              />
            </div>
          </form>
          <Link
            href="/produtos#busca"
            aria-label="Buscar na coleção"
            className={cx(iconButton, "sm:hidden")}
          >
            <IconSearch className="h-5 w-5" />
          </Link>
          <CartButton className="noir:text-ivory-200 noir:hover:bg-ivory-50/10 noir:hover:text-ivory-50 noir:focus-visible:outline-gold-200" />
        </div>
      </div>
    </header>
  );
}
