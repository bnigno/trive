import type { Metadata } from "next";
import Link from "next/link";
import { count, inArray, isNull, and } from "drizzle-orm";

import { getDb } from "@/db/client";
import { products } from "@/db/schema";
import { requireOwner } from "@/services/auth";
import { listSuppliers } from "@/services/suppliers";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { Table, Td, Tr } from "@/components/ui/table";
import { formatPhoneBR } from "../clientes/format";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Fornecedores",
};

const newSupplierButtonClasses =
  "inline-flex items-center justify-center rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500";

export default async function SuppliersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  await requireOwner("fornecedores");
  const { q } = await searchParams;
  const search = q?.trim() || undefined;

  const db = getDb();
  const suppliers = await listSuppliers(db, { search });

  // Leitura direta (não é mutação): quantidade de produtos por fornecedor.
  const supplierIds = suppliers.map((supplier) => supplier.id);
  const productCounts =
    supplierIds.length > 0
      ? await db
          .select({ supplierId: products.supplierId, total: count() })
          .from(products)
          .where(
            and(
              inArray(products.supplierId, supplierIds),
              isNull(products.deletedAt),
            ),
          )
          .groupBy(products.supplierId)
      : [];
  const productsBySupplier = new Map(
    productCounts.map((row) => [row.supplierId, row.total]),
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Fornecedores"
        subtitle="Cadastro de quem vende para você: contatos, compras e contas a pagar."
        actions={
          <Link
            href="/admin/fornecedores/novo"
            className={newSupplierButtonClasses}
          >
            Novo fornecedor
          </Link>
        }
      />

      <form
        action="/admin/fornecedores"
        method="get"
        className="flex max-w-lg items-center gap-2"
      >
        <Input
          type="search"
          name="q"
          defaultValue={search ?? ""}
          placeholder="Buscar por nome, contato, telefone ou e-mail"
          aria-label="Buscar fornecedores"
        />
        <button
          type="submit"
          className="shrink-0 rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Buscar
        </button>
      </form>

      {suppliers.length === 0 ? (
        <EmptyState
          title={
            search
              ? `Nenhum fornecedor encontrado para “${search}”`
              : "Você ainda não tem fornecedores cadastrados"
          }
          hint={
            search
              ? "Confira a grafia ou tente buscar por outro dado, como o telefone."
              : "Cadastre o primeiro fornecedor para registrar compras e contas a pagar."
          }
          action={
            <Link
              href="/admin/fornecedores/novo"
              className={newSupplierButtonClasses}
            >
              Novo fornecedor
            </Link>
          }
        />
      ) : (
        <Table headers={["Nome", "Contato", "Telefone", "E-mail", "Produtos"]}>
          {suppliers.map((supplier) => (
            <Tr key={supplier.id}>
              <Td>
                <Link
                  href={`/admin/fornecedores/${supplier.id}`}
                  className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  {supplier.name}
                </Link>
              </Td>
              <Td>{supplier.contactName ?? "—"}</Td>
              <Td className="whitespace-nowrap">
                {formatPhoneBR(supplier.phoneE164)}
              </Td>
              <Td>{supplier.email ?? "—"}</Td>
              <Td>{productsBySupplier.get(supplier.id) ?? 0}</Td>
            </Tr>
          ))}
        </Table>
      )}
    </div>
  );
}
