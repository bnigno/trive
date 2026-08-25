// Checkout: página dinâmica (lê querystring; carrinho vive no cliente).
// O frete é re-cotado no servidor (via server action, ao montar) para exibir
// SEMPRE o preço atual — e o total final é recalculado em createStoreOrder.
import type { Metadata } from "next";

import { CheckoutClient } from "./checkout-client";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Finalizar pedido",
  description: "Informe seus dados de entrega e conclua sua compra.",
};

export default async function CheckoutPage({
  searchParams,
}: {
  searchParams: Promise<{ cep?: string; frete?: string; cupom?: string }>;
}) {
  const params = await searchParams;
  const cepDigits = (params.cep ?? "").replace(/\D/g, "").slice(0, 8);
  const couponCode = (params.cupom ?? "").trim().toUpperCase().slice(0, 40);
  return (
    <CheckoutClient
      initialCepDigits={cepDigits}
      initialRateId={params.frete ?? ""}
      initialCouponCode={couponCode}
    />
  );
}
