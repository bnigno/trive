// Layout visual da LOJA (grupo de rotas (store)): header, footer e
// CartProvider. O html/body vive no layout raiz src/app/layout.tsx.
// A vitrine é claro único com momentos noir explícitos (hero, convite e
// rodapé). As fontes da maison são declaradas aqui (o admin segue com Geist).
import type { Viewport } from "next";
import { Cormorant_Garamond, Jost } from "next/font/google";
import { preconnect } from "react-dom";

import { CartProvider } from "@/components/store/cart/cart-context";
import { StoreFooter } from "@/components/store/store-footer";
import { StoreHeader } from "@/components/store/store-header";
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

// viewportFit cover: sem ele, env(safe-area-inset-*) vale 0 no iPhone e a
// barra fixa de compra / o header não respeitam o notch em paisagem.
export const viewport: Viewport = {
  themeColor: "#FAF7F0",
  viewportFit: "cover",
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

export default async function StoreLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // As fotos vêm do Supabase Storage (outra origem): abrir a conexão cedo
  // poupa ~3 RTT antes da imagem LCP do produto.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (supabaseUrl) preconnect(supabaseUrl);

  const settings = await tryOrBuildFallback({}, () =>
    getSettingsMap(getDb(), [...STORE_SETTING_KEYS]),
  );
  const storeName = asText(settings.store_name) || STORE_NAME_DEFAULT;

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

        <StoreHeader storeName={storeName} />

        <main id="conteudo" className="flex-1">
          {children}
        </main>

        <StoreFooter
          storeName={storeName}
          cnpj={asText(settings.store_cnpj)}
          address={asText(settings.store_address)}
          email={asText(settings.store_email)}
          whatsapp={asText(settings.store_whatsapp)}
        />
      </div>
    </CartProvider>
  );
}
