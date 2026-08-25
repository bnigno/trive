// Layout visual da LOJA (grupo de rotas (store)): header fixo, footer e
// CartProvider. O html/body vive no layout raiz src/app/layout.tsx.
import Link from "next/link";

import { CartButton } from "@/components/store/cart/cart-button";
import { CartProvider } from "@/components/store/cart/cart-context";
import { getDb } from "@/db/client";
import { getSettingsMap } from "@/services/settings";

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

export default async function StoreLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const settings = await getSettingsMap(getDb(), [...STORE_SETTING_KEYS]);
  const storeName = asText(settings.store_name) || "TRIVË";
  const cnpj = asText(settings.store_cnpj);
  const address = asText(settings.store_address);
  const email = asText(settings.store_email);
  const whatsapp = asText(settings.store_whatsapp);
  const hasStoreData = Boolean(cnpj || address || email || whatsapp);

  return (
    <CartProvider>
      <div className="flex min-h-screen flex-col bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
        <header className="sticky top-0 z-40 border-b border-zinc-200 bg-white/90 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/90">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
            <Link
              href="/"
              className="text-xl font-semibold tracking-[0.2em] text-zinc-900 dark:text-zinc-100"
            >
              {storeName}
            </Link>
            <div className="ml-auto sm:order-3">
              <CartButton />
            </div>
            <form
              action="/produtos"
              method="GET"
              role="search"
              className="order-3 w-full sm:order-2 sm:ml-auto sm:w-auto"
            >
              <label htmlFor="store-search" className="sr-only">
                Buscar produtos
              </label>
              <input
                id="store-search"
                type="search"
                name="q"
                placeholder="Buscar produtos…"
                className="w-full rounded-full border border-zinc-300 bg-zinc-50 px-4 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-amber-700 focus:outline-none focus:ring-2 focus:ring-amber-700/30 sm:w-64 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              />
            </form>
          </div>
        </header>

        <main className="flex-1">{children}</main>

        <footer className="mt-12 border-t border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:grid-cols-3 sm:px-6">
            <div className="space-y-1 text-sm text-zinc-600 dark:text-zinc-400">
              <p className="text-base font-semibold tracking-wide text-zinc-900 dark:text-zinc-100">
                {storeName}
              </p>
              {hasStoreData ? (
                <>
                  {cnpj ? <p>CNPJ: {cnpj}</p> : null}
                  {address ? <p>{address}</p> : null}
                  {email ? <p>{email}</p> : null}
                  {whatsapp ? <p>WhatsApp: {whatsapp}</p> : null}
                </>
              ) : (
                // Lembrete discreto para o dono da loja preencher os settings.
                <p className="text-xs italic text-zinc-400 dark:text-zinc-500">
                  Dados da loja pendentes de configuração
                </p>
              )}
            </div>
            <nav
              aria-label="Institucional"
              className="flex flex-col gap-2 text-sm"
            >
              <Link
                href="/termos"
                className="text-zinc-600 hover:text-amber-800 dark:text-zinc-400 dark:hover:text-amber-400"
              >
                Termos de Uso
              </Link>
              <Link
                href="/privacidade"
                className="text-zinc-600 hover:text-amber-800 dark:text-zinc-400 dark:hover:text-amber-400"
              >
                Política de Privacidade
              </Link>
              <Link
                href="/trocas-e-devolucoes"
                className="text-zinc-600 hover:text-amber-800 dark:text-zinc-400 dark:hover:text-amber-400"
              >
                Trocas e Devoluções
              </Link>
            </nav>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Pagamento combinado via Pix • Envio para todo o Brasil
            </p>
          </div>
        </footer>
      </div>
    </CartProvider>
  );
}
