// Sacola: página dinâmica (o conteúdo vive no cliente — carrinho em
// localStorage). Nada de ISR aqui.
import type { Metadata } from "next";

import { CartView } from "./cart-view";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sacola",
  description: "Revise os itens da sua sacola e calcule o frete.",
};

export default function CartPage() {
  return <CartView />;
}
