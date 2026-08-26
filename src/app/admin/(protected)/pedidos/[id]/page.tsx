import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import {
  ORDER_STATUS_LABELS,
  type OrderStatus,
} from "@/core/orders/state-machine";
import { PAYMENT_METHOD_LABELS } from "@/core/orders/payment-methods";
import { getDb } from "@/db/client";
import { isOwner, requireUser } from "@/services/auth";
import { getOrderDetail } from "@/services/orders";
import { OrderTimeline } from "@/components/admin/order-timeline";
import { orderPublicUrl } from "@/services/wa-messaging";

import { CopyOrderLink } from "./copy-link";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Money } from "@/components/ui/money";
import { PageHeader } from "@/components/ui/page-header";
import { StatusPill, orderStatusTone } from "@/components/ui/status-pill";
import { Table, Td, Tr } from "@/components/ui/table";
import { OwnerOnly } from "../../owner-only";
import { channelLabel, formatDateTimeSP } from "../format";
import { OrderFinancialCard } from "./financial-card";
import { OrderMarginCard } from "./margin-card";
import { OrderActions } from "./order-actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Detalhe do pedido",
};

/** Label pt-BR do método vindo do core; método desconhecido volta cru. */
function paymentMethodLabel(method: string): string {
  return (PAYMENT_METHOD_LABELS as Record<string, string>)[method] ?? method;
}

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

  const status = order.status as OrderStatus;
  // Reembolso mexe no financeiro (lançamento de saída): só o dono. A action
  // também barra pelo servidor — isto aqui é só para não mostrar botão morto.
  const owner = await isOwner();

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

      <Card title="Link do pedido — envie ao cliente pelo WhatsApp">
        <div className="flex flex-col gap-2">
          <CopyOrderLink url={orderPublicUrl(order.publicToken)} />
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {order.paymentMethod === "cash"
              ? "Por esse link o cliente acompanha o pedido. Pagamento em dinheiro na entrega — marque como pago aqui quando receber."
              : 'Por esse link o cliente acompanha o pedido e, quando estiver aguardando pagamento, paga com Pix ou cartão pelo Mercado Pago — o pedido vira "Pago" sozinho.'}
          </p>
        </div>
      </Card>

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

          <Card title="Pagamento">
            <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <div className="flex items-center justify-between gap-4 sm:flex-col sm:items-start sm:gap-0.5">
                <dt className="text-zinc-500 dark:text-zinc-400">Método</dt>
                <dd className="text-zinc-900 dark:text-zinc-100">
                  {order.paymentMethod
                    ? paymentMethodLabel(order.paymentMethod)
                    : "—"}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4 sm:flex-col sm:items-start sm:gap-0.5">
                <dt className="text-zinc-500 dark:text-zinc-400">Parcelas</dt>
                <dd className="text-zinc-900 dark:text-zinc-100">
                  {order.installments !== null ? `${order.installments}×` : "—"}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4 sm:flex-col sm:items-start sm:gap-0.5">
                <dt className="text-zinc-500 dark:text-zinc-400">
                  Pagamento no Mercado Pago
                </dt>
                <dd className="font-mono text-xs text-zinc-900 dark:text-zinc-100">
                  {order.mpPaymentId ?? "—"}
                </dd>
              </div>
              {/* Método, parcelas e id do MP são operacionais; o valor da taxa
                  é dinheiro do negócio e fica só com o dono. */}
              <OwnerOnly>
                <div className="flex items-center justify-between gap-4 sm:flex-col sm:items-start sm:gap-0.5">
                  <dt className="text-zinc-500 dark:text-zinc-400">
                    Taxa real do MP
                  </dt>
                  <dd className="text-zinc-900 dark:text-zinc-100">
                    {order.mpFeeCents !== null ? (
                      <Money cents={order.mpFeeCents} />
                    ) : (
                      "—"
                    )}
                  </dd>
                </div>
              </OwnerOnly>
            </dl>
          </Card>

          <OrderMarginCard order={order} />

          <OrderFinancialCard orderId={order.id} />

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
              {order.paymentMethod === "cash" &&
              status === "pending_payment" ? (
                <div className="flex flex-col gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-800 dark:bg-amber-950">
                  <Badge tone="warning" className="self-start">
                    Dinheiro na entrega
                  </Badge>
                  <p className="text-xs text-amber-800 dark:text-amber-300">
                    Sem prazo de expiração: marcar como pago = dinheiro na mão.
                  </p>
                </div>
              ) : null}
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
              paymentMethod={order.paymentMethod}
              trackingCode={order.shippingTrackingCode}
              canRefund={owner}
            />
          </Card>
        </div>
      </div>
    </div>
  );
}
