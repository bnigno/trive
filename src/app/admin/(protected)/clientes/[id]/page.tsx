import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { getDb } from "@/db/client";
import { requireUser } from "@/services/auth";
import { ServiceError } from "@/services/catalog";
import { getCustomerDetail } from "@/services/customers";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Money } from "@/components/ui/money";
import { PageHeader } from "@/components/ui/page-header";
import { StatusPill, orderStatusTone } from "@/components/ui/status-pill";
import { Table, Td, Tr } from "@/components/ui/table";
import { CustomerForm } from "../customer-form";
import { setDefaultAddressAction } from "../actions";
import {
  dateTimeFormatter,
  formatDocumentBR,
  formatPhoneBR,
  orderStatusLabel,
} from "../format";
import { AddressForm } from "./address-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Cliente",
};

type Detail = Awaited<ReturnType<typeof getCustomerDetail>>;

function addressLines(address: Detail["addresses"][number]): string[] {
  const line1 = [address.street, address.number].filter(Boolean).join(", ");
  const line2 = [
    address.complement,
    address.district,
    [address.city, address.state].filter(Boolean).join(" - "),
  ]
    .filter(Boolean)
    .join(" · ");
  const line3 = address.postalCode ? `CEP ${address.postalCode}` : "";
  return [line1, line2, line3].filter((line) => line.length > 0);
}

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireUser();
  const { id } = await params;

  const db = getDb();
  let detail: Detail;
  try {
    detail = await getCustomerDetail(db, id);
  } catch (error) {
    if (
      error instanceof z.ZodError ||
      (error instanceof ServiceError && error.code === "nao_encontrado")
    ) {
      notFound();
    }
    throw error;
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={detail.fullName}
        subtitle={`Cliente desde ${dateTimeFormatter.format(detail.createdAt)}`}
        actions={
          <Link
            href="/admin/clientes"
            className="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
          >
            ← Voltar para clientes
          </Link>
        }
      />

      <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
        <span>{formatPhoneBR(detail.phoneE164)}</span>
        <span aria-hidden>·</span>
        <span>{detail.email ?? "sem e-mail"}</span>
        <span aria-hidden>·</span>
        <span>
          {detail.documentType
            ? `${detail.documentType.toUpperCase()} ${formatDocumentBR(detail.documentType, detail.documentNumber)}`
            : "sem CPF/CNPJ"}
        </span>
        {detail.marketingOptIn ? (
          <Badge tone="success">Aceita mensagens no WhatsApp</Badge>
        ) : (
          <Badge tone="neutral">Sem consentimento para WhatsApp</Badge>
        )}
      </div>

      <div className="grid items-start gap-6 xl:grid-cols-2">
        <Card title="Dados do cliente">
          <CustomerForm
            initial={{
              id: detail.id,
              fullName: detail.fullName,
              email: detail.email ?? "",
              phone: detail.phoneE164 ? formatPhoneBR(detail.phoneE164) : "",
              document: detail.documentNumber
                ? formatDocumentBR(detail.documentType, detail.documentNumber)
                : "",
              notes: detail.notes ?? "",
              marketingOptIn: detail.marketingOptIn,
            }}
          />
        </Card>

        <div className="flex flex-col gap-6">
          <Card title="Endereços">
            {detail.addresses.length === 0 ? (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                Nenhum endereço cadastrado ainda. Adicione o primeiro abaixo —
                ele vira o endereço padrão de entrega.
              </p>
            ) : (
              <ul className="flex flex-col gap-3">
                {detail.addresses.map((address) => (
                  <li
                    key={address.id}
                    className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-zinc-200 px-4 py-3 dark:border-zinc-800"
                  >
                    <div className="text-sm text-zinc-700 dark:text-zinc-300">
                      <p className="flex items-center gap-2 font-medium text-zinc-900 dark:text-zinc-100">
                        {address.label ?? "Endereço"}
                        {address.isDefault ? (
                          <Badge tone="info">Padrão</Badge>
                        ) : null}
                      </p>
                      {addressLines(address).map((line) => (
                        <p key={line} className="mt-0.5">
                          {line}
                        </p>
                      ))}
                      {addressLines(address).length === 0 ? (
                        <p className="mt-0.5 text-zinc-500 dark:text-zinc-400">
                          Endereço sem dados preenchidos.
                        </p>
                      ) : null}
                    </div>
                    {!address.isDefault ? (
                      <form action={setDefaultAddressAction}>
                        <input
                          type="hidden"
                          name="addressId"
                          value={address.id}
                        />
                        <button
                          type="submit"
                          className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                        >
                          Tornar padrão
                        </button>
                      </form>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}

            <details className="mt-4 rounded-md border border-zinc-200 dark:border-zinc-800">
              <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-medium text-indigo-600 dark:text-indigo-400">
                Adicionar endereço
              </summary>
              <div className="border-t border-zinc-200 p-4 dark:border-zinc-800">
                <AddressForm customerId={detail.id} />
              </div>
            </details>
          </Card>

          <Card title="Últimos pedidos">
            {detail.recentOrders.length === 0 ? (
              <EmptyState
                title="Este cliente ainda não tem pedidos"
                hint="Quando você registrar uma venda para ele, ela aparece aqui."
                action={
                  <Link
                    href="/admin/pedidos/novo"
                    className="inline-flex items-center justify-center rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
                  >
                    Novo pedido
                  </Link>
                }
              />
            ) : (
              <Table headers={["Pedido", "Status", "Total", "Data"]}>
                {detail.recentOrders.map((order) => (
                  <Tr key={order.id}>
                    <Td>
                      <Link
                        href={`/admin/pedidos/${order.id}`}
                        className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                      >
                        #{order.orderNumber}
                      </Link>
                    </Td>
                    <Td>
                      <StatusPill
                        label={orderStatusLabel(order.status)}
                        tone={orderStatusTone(order.status)}
                      />
                    </Td>
                    <Td className="whitespace-nowrap">
                      <Money cents={order.totalCents} />
                    </Td>
                    <Td className="whitespace-nowrap">
                      {dateTimeFormatter.format(order.createdAt)}
                    </Td>
                  </Tr>
                ))}
              </Table>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
