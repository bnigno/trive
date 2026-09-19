import type { Metadata } from "next";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Money } from "@/components/ui/money";
import { PageHeader } from "@/components/ui/page-header";
import { PAYMENT_METHOD_LABELS_SHORT, type PaymentMethod } from "@/core/orders/payment-methods";
import { getDb } from "@/db/client";
import { requireUser } from "@/services/auth";
import { listOrdersAwaitingDelivery, listStaleShipments } from "@/services/delivery";
import { STALE_SHIPMENT_DAYS } from "@/core/orders/delivery";
import { formatDateTimeSP } from "../format";
import { DeliverForm } from "../[id]/deliver-form";
import { DeliveredForm } from "../rota/forms";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Mesa de entrega" };

// A mesa de entrega, pensada para o celular: pedidos enviados (Correios,
// motoboy que saiu) e os pagos para entrega em mãos, cada um com a câmera
// a um toque. Sem regra aqui: tudo vem de listOrdersAwaitingDelivery.
export default async function EntregarPage() {
  await requireUser();
  const [rows, stale] = await Promise.all([listOrdersAwaitingDelivery(getDb()), listStaleShipments(getDb())]);
  const staleIds = new Set(stale.map((row) => row.id));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Mesa de entrega"
        subtitle={rows.length === 0 ? "Pedidos a caminho da cliente, esperando a foto da entrega." : `${rows.length} ${rows.length === 1 ? "pedido" : "pedidos"} para entregar`}
        actions={
          <Link href="/admin/pedidos" className="text-sm text-zinc-600 hover:underline dark:text-zinc-400">
            ← Todos os pedidos
          </Link>
        }
      />

      {stale.length > 0 ? (
        <section className="rounded-lg border border-amber-200 bg-amber-50 px-5 py-4 dark:border-amber-900 dark:bg-amber-950/40" aria-label="Enviados sem confirmação">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            Enviados há {STALE_SHIPMENT_DAYS}+ dias sem confirmação · {stale.length}
          </h2>
          <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
            Correios: a cliente ainda não tocou em “Chegou!” nem disse à Lia que recebeu — confira o rastreio ou chame no WhatsApp. Motoboy: saiu e ficou sem a foto da entrega — registre abaixo.
          </p>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {stale.map((row) => (
              <li key={row.id}>
                <Link href={`/admin/pedidos/${row.id}`} className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
                  #{row.orderNumber}
                </Link>{" "}
                <span className="text-zinc-600 dark:text-zinc-400">
                  {row.customerName} · {row.isMotoboy ? "🛵 saiu" : "enviado"} há {row.days} dias{row.trackingCode ? ` · ${row.trackingCode}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState title="Nada para entregar agora." hint="Quando um pedido sair (Correios ou motoboy que já saiu) ou for pago em dinheiro na entrega, ele aparece aqui com a câmera pronta." />
      ) : (
        <ul className="flex flex-col gap-4">
          {rows.map((row) => (
            <li key={row.id} className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <Link href={`/admin/pedidos/${row.id}`} className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
                    #{row.orderNumber}
                  </Link>
                  <span className="ml-2 text-sm text-zinc-700 dark:text-zinc-300">{row.customerName}</span>
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                    <Badge tone={row.status === "shipped" ? "info" : row.awaitingPayment ? "warning" : "neutral"}>
                      {row.status === "shipped"
                        ? "Enviado"
                        : row.awaitingPayment
                          ? "Saiu — dinheiro a receber"
                          : row.status === "preparing" || row.dispatchedAt
                            ? "Saiu com o motoboy"
                            : "Pago — entrega em mãos"}
                    </Badge>
                    {row.isMotoboy ? <span>🛵 motoboy{row.dispatchedAt ? ` · saiu ${formatDateTimeSP(row.dispatchedAt)}` : ""}</span> : null}
                    {row.trackingCode ? <span>rastreio {row.trackingCode}</span> : null}
                    {row.paymentMethod ? <span>{PAYMENT_METHOD_LABELS_SHORT[row.paymentMethod as PaymentMethod] ?? row.paymentMethod}</span> : null}
                    {row.shippedAt ? <span>enviado {formatDateTimeSP(row.shippedAt)}</span> : row.paidAt ? <span>pago {formatDateTimeSP(row.paidAt)}</span> : null}
                    {staleIds.has(row.id) ? <Badge tone="warning">sem confirmação há {STALE_SHIPMENT_DAYS}+ dias</Badge> : null}
                  </p>
                </div>
                <Money cents={row.totalCents} />
              </div>
              <div className="mt-3">
                {row.awaitingPayment ? (
                  <p className="text-sm text-zinc-600 dark:text-zinc-400">
                    {row.hasPhoto ? "O motoboy entregou e a foto está registrada. " : ""}
                    Receba o dinheiro e{" "}
                    <Link href={`/admin/pedidos/${row.id}`} className="underline">
                      marque como pago na ficha
                    </Link>
                    {row.hasPhoto ? "; depois é só fechar aqui." : "; a câmera aparece em seguida."}
                  </p>
                ) : row.hasPhoto && row.dispatchedAt ? (
                  <div className="flex flex-col gap-2">
                    <p className="text-sm text-zinc-600 dark:text-zinc-400">Foto da entrega registrada pelo motoboy — a cliente recebe quando você fechar.</p>
                    <DeliveredForm orderId={row.id} />
                  </div>
                ) : (
                  <DeliverForm orderId={row.id} photoUrl={null} receivedBy={null} deliveredAtLabel={null} compact />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
