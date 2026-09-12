// Sacola: página dinâmica (o conteúdo vive no cliente — carrinho em
// localStorage). Nada de ISR aqui.
import type { Metadata } from "next";

import { getDb } from "@/db/client";
import { loadBridgeSettings, plainBridgeUrl } from "@/services/site-carts";

import { CartView } from "./cart-view";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sacola",
  description: "Revise os itens da sua sacola e calcule o frete.",
  robots: { index: false, follow: false },
};

export default async function CartPage() {
  // "Falar com a Lia" com a sacola: o telefone da loja e o nome da vendedora.
  // Banco fora do ar não derruba a sacola por causa de um botão opcional.
  let lia: { sellerName: string; fallbackUrl: string | null } | null = null;
  try {
    const bridge = await loadBridgeSettings(getDb());
    lia = { sellerName: bridge.sellerName, fallbackUrl: plainBridgeUrl(bridge) };
  } catch (error) {
    console.error("[carrinho] settings da ponte indisponíveis", error);
  }
  return <CartView lia={lia} />;
}
