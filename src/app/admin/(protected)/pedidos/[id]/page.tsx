import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { z } from "zod";

import {
  ORDER_STATUS_LABELS,
  type OrderStatus,
} from "@/core/orders/state-machine";
import { getDb } from "@/db/client";
import { financialEntries } from "@/db/schema";
import { requireUser } from "@/services/auth";
import { getOrderDetail } from "@/services/orders";
import { OrderTimeline } from "@/components/admin/order-timeline";
import { Card } from "@/components/ui/card";
import { Money } from "@/components/ui/money";
import { PageHeader } from "@/components/ui/page-header";
import { StatusPill, orderStatusTone } from "@/components/ui/status-pill";
import { Table, Td, Tr } from "@/components/ui/table";
import { channelLabel, formatDateTimeSP } from "../format";
import { OrderActions } from "./order-actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Detalhe do pedido",
};

const ENTRY_DIRECTION_LABELS: Record<string, string> = {
  receivable: "A receber",
  payable: "A pagar",
};

const ENTRY_STATUS_LABELS: Record<string, string> = {
  pending: "Pendente",
  settled: "Liquidado",
  canceled: "Cancelado",
};

export default async function PedidoDetalhePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireUser();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();

  const db = getDb();
  const order = await getOrderDetail(db, id);
  if (!order) notFound();

  // Leitura simples (sem mutação): lançamentos financeiros ligados ao pedido.
  const entries = await db
    .select()
    .from(financialEntries)
    .where(eq(financialEntries.orderId, order.id))
    .orderBy(financialEntries.createdAt);

  const status = order.status as OrderStatus;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={`Pedido #${order.orderNumber}`}
        subtitle={`Criado em ${formatDateTimeSP(order.createdAt)} · Canal: ${channelLabel(order.channel)}`}
        actions={
          <Link
            href="/admin/pedidos"
            className="text-sm text-zinc-600 hover:underline dark:text-zinc-400"
          >
            ← Voltar para pedidos
          </Link>
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <Card title="Itens">
            <Table headers={["SKU", "Produto", "Qtd.", "Unitário", "Total"]}>
              {order.items.map((item) => (
                <Tr key={item.id}>
                  <Td className="font-mono text-xs">{item.skuSnapshot}</Td>
                  <Td>{item.nameSnapshot}</Td>
                  <Td>{item.quantity}</Td>
                  <Td>
                    <Money cents={item.unitPriceCents} />
                  </Td>
                  <Td>
                    <Money cents={item.totalCents} className="font-medium" />
                  </Td>
                </Tr>
              ))}
            </Table>
            <dl className="mt-4 ml-auto flex max-w-xs flex-col gap-1.5 text-sm">
              <div className="flex justify-between gap-8">
                <dt className="text-zinc-500 dark:text-zinc-400">Subtotal</dt>
                <dd className="text-zinc-900 dark:text-zinc-100">
                  <Money cents={order.subtotalCents} />
                </dd>
              </div>
              <div className="flex justify-between gap-8">
                <dt className="text-zinc-500 dark:text-zinc-400">Desconto</dt>
                <dd className="text-zinc-900 dark:text-zinc-100">
                  − <Money cents={order.discountCents} />
                </dd>
              </div>
              <div className="flex justify-between gap-8">
                <dt className="text-zinc-500 dark:text-zinc-400">Frete</dt>
                <dd className="text-zinc-900 dark:text-zinc-100">
                  + <Money cents={order.shippingCents} />
                </dd>
              </div>
              <div className="flex justify-between gap-8 border-t border-zinc-200 pt-1.5 font-semibold dark:border-zinc-800">
                <dt className="text-zinc-900 dark:text-zinc-100">Total</dt>
                <dd className="text-zinc-900 dark:text-zinc-100">
                  <Money cents={order.totalCents} />
                </dd>
              </div>
            </dl>
          </Card>

          <Card title="Financeiro do pedido">
            {entries.length === 0 ? (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                Nenhum lançamento financeiro ainda. Ao marcar o pedido como
                pago, a venda é lançada automaticamente.
              </p>
            ) : (
              <Table headers={["Descrição", "Tipo", "Valor", "Situação", "Data"]}>
                {entries.map((entry) => (
                  <Tr key={entry.id}>
                    <Td>{entry.description}</Td>
                    <Td>
                      {ENTRY_DIRECTION_LABELS[entry.direction] ??
                        entry.direction}
                    </Td>
                    <Td>
                      <Money cents={entry.amountCents} className="font-medium" />
                    </Td>
                    <Td>
                      {ENTRY_STATUS_LABELS[entry.status] ?? entry.status}
                    </Td>
                    <Td className="whitespace-nowrap">
                      {formatDateTimeSP(entry.createdAt)}
                    </Td>
                  </Tr>
                ))}
              </Table>
            )}
            <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
              Veja tudo em{" "}
              <Link
                href="/admin/financeiro"
                className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
              >
                Financeiro
              </Link>
              .
            </p>
          </Card>

          <Card title="Linha do tempo">
            <OrderTimeline
              history={order.history.map((entry) => ({
                fromStatus: entry.fromStatus,
                toStatus: entry.toStatus,
                reason: entry.reason,
                createdAt: entry.createdAt.toISOString(),
              }))}
              labels={ORDER_STATUS_LABELS}
            />
          </Card>
        </div>

        <div className="flex flex-col gap-6">
          <Card title="Resumo">
            <div className="flex flex-col gap-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-zinc-500 dark:text-zinc-400">Status</span>
                <StatusPill
                  label={ORDER_STATUS_LABELS[status] ?? order.status}
                  tone={orderStatusTone(order.status)}
                />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-500 dark:text-zinc-400">Total</span>
                <Money
                  cents={order.totalCents}
                  className="text-lg font-semibold text-zinc-900 dark:text-zinc-100"
                />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-500 dark:text-zinc-400">Canal</span>
                <span className="text-zinc-900 dark:text-zinc-100">
                  {channelLabel(order.channel)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-500 dark:text-zinc-400">
                  Criado em
                </span>
                <span className="text-zinc-900 dark:text-zinc-100">
                  {formatDateTimeSP(order.createdAt)}
                </span>
              </div>
              {order.shippingTrackingCode ? (
                <div className="flex items-center justify-between">
                  <span className="text-zinc-500 dark:text-zinc-400">
                    Rastreio
                  </span>
                  <span className="font-mono text-xs text-zinc-900 dark:text-zinc-100">
                    {order.shippingTrackingCode}
                  </span>
                </div>
              ) : null}
              {order.cancelReason ? (
                <div className="flex flex-col gap-0.5">
                  <span className="text-zinc-500 dark:text-zinc-400">
                    Motivo do cancelamento
                  </span>
                  <span className="text-zinc-900 dark:text-zinc-100">
                    {order.cancelReason}
                  </span>
                </div>
              ) : null}
              {order.note ? (
                <div className="flex flex-col gap-0.5">
                  <span className="text-zinc-500 dark:text-zinc-400">
                    Observação
                  </span>
                  <span className="text-zinc-900 dark:text-zinc-100">
                    {order.note}
                  </span>
                </div>
              ) : null}
            </div>
          </Card>

          <Card title="Cliente">
            {order.customer ? (
              <div className="flex flex-col gap-1 text-sm">
                <Link
                  href={`/admin/clientes/${order.customer.id}`}
                  className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  {order.customer.fullName}
                </Link>
                {order.customer.phoneE164 ? (
                  <p className="text-zinc-700 dark:text-zinc-300">
                    {order.customer.phoneE164}
                  </p>
                ) : null}
                {order.customer.email ? (
                  <p className="text-zinc-500 dark:text-zinc-400">
                    {order.customer.email}
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                Cliente não encontrado.
              </p>
            )}
          </Card>

          <Card title="Ações">
            <OrderActions
              orderId={order.id}
              status={status}
              trackingCode={order.shippingTrackingCode}
            />
          </Card>
        </div>
      </div>
    </div>
  );
}
