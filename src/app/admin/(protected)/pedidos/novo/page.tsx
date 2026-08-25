import type { Metadata } from "next";
import Link from "next/link";

import { getDb } from "@/db/client";
import { requireUser } from "@/services/auth";
import { listCustomers } from "@/services/customers";
import { listPricesOverview } from "@/services/pricing";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { NewOrderForm } from "./new-order-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Novo pedido",
};

export default async function NovoPedidoPage() {
  await requireUser();
  const db = getDb();
  const [customers, priceRows] = await Promise.all([
    listCustomers(db),
    listPricesOverview(db),
  ]);

  const variants = priceRows.map((row) => ({
    variantId: row.variantId,
    sku: row.sku,
    productName: row.productName,
    activePriceCents: row.activePriceCents,
  }));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Novo pedido"
        subtitle="Registre uma venda manual. O pedido nasce como rascunho — você confirma depois."
      />

      {variants.length === 0 ? (
        <EmptyState
          title="Nenhum produto cadastrado ainda."
          hint="Cadastre um produto (e defina o preço dele) antes de criar pedidos."
          action={
            <Link
              href="/admin/produtos/novo"
              className="inline-flex items-center justify-center rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
            >
              Cadastrar produto
            </Link>
          }
        />
      ) : (
        <NewOrderForm customers={customers} variants={variants} />
      )}
    </div>
  );
}
