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
  const bridge = await loadBridgeSettings(getDb());
  return <CartView lia={{ sellerName: bridge.sellerName, fallbackUrl: plainBridgeUrl(bridge) }} />;
}
