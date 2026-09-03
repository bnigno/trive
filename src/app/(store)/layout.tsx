// Layout visual da LOJA (grupo de rotas (store)): header fixo, footer e
// CartProvider. O html/body vive no layout raiz src/app/layout.tsx.
// A vitrine "Boutique Clara" é claro único: as fontes da maison são declaradas
// aqui (o admin segue com Geist, sem preload extra).
import type { Viewport } from "next";
import { Cormorant_Garamond, Jost } from "next/font/google";
import Link from "next/link";

import { Monogram } from "@/components/store/brand/monogram";
import { Wordmark } from "@/components/store/brand/wordmark";
import { CartButton } from "@/components/store/cart/cart-button";
import { CartProvider } from "@/components/store/cart/cart-context";
import { IconSearch } from "@/components/store/icons";
import { Ornament } from "@/components/store/ornament";
import { eyebrow } from "@/components/store/styles";
import { getDb } from "@/db/client";
import { STORE_NAME_DEFAULT } from "@/lib/brand";
import { tryOrBuildFallback } from "@/lib/build-safe";
import { getSettingsMap } from "@/services/settings";

// Cada peso × estilo vira um arquivo pré-carregado que disputa banda com a
// imagem LCP: 400 (hero, manifesto, itálicos) e 600 (títulos) bastam.
const cormorant = Cormorant_Garamond({
  variable: "--font-cormorant",
  subsets: ["latin", "latin-ext"],
  weight: ["400", "600"],
  style: ["normal", "italic"],
  display: "swap",
});

const jost = Jost({
  variable: "--font-jost",
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500"],
  display: "swap",
});

export const viewport: Viewport = {
  themeColor: "#FAF7F0",
};

const STORE_SETTING_KEYS = [
  "store_name",
  "store_cnpj",
  "store_address",
  "store_email",
  "store_whatsapp",
] as const;

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const navLink =
  "border-b border-transparent pb-0.5 font-store text-eyebrow font-medium uppercase text-ink-700 transition-colors duration-300 hover:border-gold-500 hover:text-ink-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600";

const footerLink =
  "text-sm text-ink-700 transition-colors duration-300 hover:text-gold-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600";

export default async function StoreLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const settings = await tryOrBuildFallback({}, () =>
    getSettingsMap(getDb(), [...STORE_SETTING_KEYS]),
  );
  const storeName = asText(settings.store_name) || STORE_NAME_DEFAULT;
  const cnpj = asText(settings.store_cnpj);
  const address = asText(settings.store_address);
  const email = asText(settings.store_email);
  const whatsapp = asText(settings.store_whatsapp);
  const hasStoreData = Boolean(cnpj || address || email || whatsapp);

  return (
    <CartProvider>
      <div
        data-store=""
        className={`${cormorant.variable} ${jost.variable} flex min-h-screen flex-col bg-ivory-100 font-store text-ink-900`}
      >
        <a
          href="#conteudo"
          className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[110] focus:rounded-(--radius-hair) focus:bg-ink-950 focus:px-4 focus:py-2 focus:font-store focus:text-sm focus:text-ivory-50"
        >
          Pular para o conteúdo
        </a>
        <header className="sticky top-0 z-40 border-b border-ivory-300 bg-ivory-50/90 backdrop-blur">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
            <Link
              href="/"
              className="flex items-center gap-2.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600"
            >
              <Monogram size={30} />
              <Wordmark className="text-lg text-ink-950">{storeName}</Wordmark>
            </Link>
            <nav
              aria-label="Principal"
              className="hidden items-center gap-6 sm:order-2 sm:ml-8 sm:flex"
            >
              <Link href="/" className={navLink}>
                Início
              </Link>
              <Link href="/produtos" className={navLink}>
                Produtos
              </Link>
            </nav>
            <div className="ml-auto sm:order-4">
              <CartButton />
            </div>
            <form
              action="/produtos"
              method="GET"
              role="search"
              className="order-4 w-full sm:order-3 sm:ml-auto sm:w-auto"
            >
              <label htmlFor="store-search" className="sr-only">
                Buscar produtos
              </label>
              <div className="relative sm:w-64">
                <IconSearch className="pointer-events-none absolute top-1/2 left-0 h-4 w-4 -translate-y-1/2 text-ink-400" />
                <input
                  id="store-search"
                  type="search"
                  name="q"
                  placeholder="Buscar produtos…"
                  className="w-full appearance-none rounded-none border-0 border-b border-ivory-300 bg-transparent py-2 pr-1 pl-6 font-store text-sm text-ink-900 transition-colors duration-300 placeholder:text-ink-400 focus:border-gold-600 focus:outline-none"
                />
              </div>
            </form>
          </div>
        </header>

        <main id="conteudo" className="flex-1">
          {children}
        </main>

        <footer className="mt-16 border-t border-ivory-300 bg-ivory-50">
          <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
            <div className="flex flex-col items-center gap-4">
              <Monogram size={40} />
              <Ornament className="text-gold-500" />
            </div>
            <div className="mt-10 grid gap-10 sm:grid-cols-3">
              <div className="space-y-1.5">
                <p className={`${eyebrow} mb-3`}>A maison</p>
                <p className="font-display text-base font-semibold tracking-[0.2em] text-ink-950">
                  {storeName}
                </p>
                {hasStoreData ? (
                  <div className="space-y-1 text-sm text-ink-700">
                    {cnpj ? <p>CNPJ: {cnpj}</p> : null}
                    {address ? <p>{address}</p> : null}
                    {email ? <p>{email}</p> : null}
                    {whatsapp ? <p>WhatsApp: {whatsapp}</p> : null}
                  </div>
                ) : (
                  // Lembrete discreto para o dono da loja preencher os settings.
                  <p className="text-xs text-ink-400 italic">
                    Dados da loja pendentes de configuração
                  </p>
                )}
              </div>
              <nav aria-label="Institucional" className="flex flex-col gap-2">
                <p className={`${eyebrow} mb-1`}>Institucional</p>
                <Link href="/termos" className={footerLink}>
                  Termos de Uso
                </Link>
                <Link href="/privacidade" className={footerLink}>
                  Política de Privacidade
                </Link>
                <Link href="/trocas-e-devolucoes" className={footerLink}>
                  Trocas e Devoluções
                </Link>
              </nav>
              <div className="space-y-1.5">
                <p className={`${eyebrow} mb-3`}>Atendimento</p>
                <p className="text-sm text-ink-700">
                  Pagamento combinado via Pix
                </p>
                <p className="text-sm text-ink-700">Envio para todo o Brasil</p>
              </div>
            </div>
            <p className="mt-12 border-t border-ivory-300 pt-6 text-center font-store text-xs tracking-[0.2em] text-ink-500 uppercase">
              © {new Date().getFullYear()} {storeName}
            </p>
          </div>
        </footer>
      </div>
    </CartProvider>
  );
}
