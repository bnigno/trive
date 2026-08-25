import type { Metadata } from "next";
import Link from "next/link";

import { requireUser } from "@/services/auth";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { CustomerForm } from "../customer-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Novo cliente",
};

export default async function NewCustomerPage() {
  await requireUser();

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageHeader
        title="Novo cliente"
        subtitle="Só o nome é obrigatório — os demais dados podem ser completados depois."
        actions={
          <Link
            href="/admin/clientes"
            className="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
          >
            ← Voltar para clientes
          </Link>
        }
      />

      <Card>
        <CustomerForm />
      </Card>
    </div>
  );
}
