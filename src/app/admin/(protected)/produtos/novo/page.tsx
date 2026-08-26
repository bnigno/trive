import type { Metadata } from "next";
import Link from "next/link";
import { asc } from "drizzle-orm";
import { getDb } from "@/db/client";
import { categories } from "@/db/schema";
import { requireOwner } from "@/services/auth";
import { PageHeader } from "@/components/ui/page-header";
import { NewProductForm } from "./new-product-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Novo produto",
};

export default async function NovoProdutoPage() {
  await requireOwner("produtos");
  const db = getDb();
  const categoryRows = await db
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .orderBy(asc(categories.name));

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <PageHeader
        title="Novo produto"
        subtitle="Produto, cores, tamanhos, quantidade e fotos — tudo numa tela só."
        actions={
          <Link
            href="/admin/produtos"
            className="text-sm font-medium text-zinc-600 hover:underline dark:text-zinc-400"
          >
            Voltar para produtos
          </Link>
        }
      />
      <NewProductForm categoryOptions={categoryRows} />
    </div>
  );
}
