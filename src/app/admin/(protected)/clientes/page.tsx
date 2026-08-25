import type { Metadata } from "next";
import Link from "next/link";
import { count, inArray } from "drizzle-orm";

import { getDb } from "@/db/client";
import { orders } from "@/db/schema";
import { requireUser } from "@/services/auth";
import { listCustomers } from "@/services/customers";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { Table, Td, Tr } from "@/components/ui/table";
import { formatPhoneBR } from "./format";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Clientes",
};

const newCustomerButtonClasses =
  "inline-flex items-center justify-center rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500";

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  await requireUser();
  const { q } = await searchParams;
  const search = q?.trim() || undefined;

  const db = getDb();
  const customers = await listCustomers(db, { search });

  // Leitura direta (não é mutação): quantidade de pedidos por cliente.
  const customerIds = customers.map((customer) => customer.id);
  const orderCounts =
    customerIds.length > 0
      ? await db
          .select({ customerId: orders.customerId, total: count() })
          .from(orders)
          .where(inArray(orders.customerId, customerIds))
          .groupBy(orders.customerId)
      : [];
  const ordersByCustomer = new Map(
    orderCounts.map((row) => [row.customerId, row.total]),
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Clientes"
        subtitle="Cadastro de quem compra de você: contatos, endereços e histórico de pedidos."
        actions={
          <Link href="/admin/clientes/novo" className={newCustomerButtonClasses}>
            Novo cliente
          </Link>
        }
      />

      <form
        action="/admin/clientes"
        method="get"
        className="flex max-w-lg items-center gap-2"
      >
        <Input
          type="search"
          name="q"
          defaultValue={search ?? ""}
          placeholder="Buscar por nome, telefone ou e-mail"
          aria-label="Buscar clientes"
        />
        <button
          type="submit"
          className="shrink-0 rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Buscar
        </button>
      </form>

      {customers.length === 0 ? (
        <EmptyState
          title={
            search
              ? `Nenhum cliente encontrado para “${search}”`
              : "Você ainda não tem clientes cadastrados"
          }
          hint={
            search
              ? "Confira a grafia ou tente buscar por outro dado, como o telefone."
              : "Cadastre o primeiro cliente para registrar pedidos e contatos."
          }
          action={
            <Link
              href="/admin/clientes/novo"
              className={newCustomerButtonClasses}
            >
              Novo cliente
            </Link>
          }
        />
      ) : (
        <Table
          headers={["Nome", "Telefone", "E-mail", "WhatsApp", "Pedidos"]}
        >
          {customers.map((customer) => (
            <Tr key={customer.id}>
              <Td>
                <Link
                  href={`/admin/clientes/${customer.id}`}
                  className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  {customer.fullName}
                </Link>
              </Td>
              <Td className="whitespace-nowrap">
                {formatPhoneBR(customer.phoneE164)}
              </Td>
              <Td>{customer.email ?? "—"}</Td>
              <Td>
                {customer.marketingOptIn ? (
                  <Badge tone="success">Aceita mensagens</Badge>
                ) : (
                  <Badge tone="neutral">Sem consentimento</Badge>
                )}
              </Td>
              <Td>{ordersByCustomer.get(customer.id) ?? 0}</Td>
            </Tr>
          ))}
        </Table>
      )}
    </div>
  );
}
