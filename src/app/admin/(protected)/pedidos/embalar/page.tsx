import type { Metadata } from "next";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Money } from "@/components/ui/money";
import { PageHeader } from "@/components/ui/page-header";
import { getDb } from "@/db/client";
import { requireUser } from "@/services/auth";
import { listOrdersAwaitingPacking } from "@/services/packing";
import { formatDateTimeSP } from "../format";
import { PackForm } from "../[id]/pack-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Mesa de embalagem",
};

/** "pago há 3h" / "pago ontem" para o dono decidir a ordem da mesa. */
function paidAgo(paidAt: Date | null): string {
  if (!paidAt) return "pago";
  const hours = Math.floor((Date.now() - paidAt.getTime()) / 3_600_000);
  if (hours < 1) return "pago agora há pouco";
  if (hours < 24) return `pago há ${hours} h`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "pago ontem" : `pago há ${days} dias`;
}

// Mesa de embalagem: a lista dos pedidos pagos que ainda não têm a foto do
// pacote, feita para o celular na mão — um card por pedido, o botão
// "Embalei" abre a câmera. Sem regra aqui: tudo vem de listOrdersAwaitingPacking.
export default async function EmbalarPage() {
  await requireUser();
  const rows = await listOrdersAwaitingPacking(getDb());

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Mesa de embalagem"
        subtitle="Pedidos pagos esperando a foto do pacote. Tire a foto pelo celular e a cliente recebe na hora."
        actions={
          <Link
            href="/admin/pedidos"
            className="text-sm text-zinc-600 hover:underline dark:text-zinc-400"
          >
            ← Todos os pedidos
          </Link>
        }
      />

      {rows.length === 0 ? (
        <EmptyState
          title="Nada para embalar — tudo em dia."
          hint="Quando um pedido for pago, ele aparece aqui até você registrar a foto do pacote."
        />
      ) : (
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((order) => (
            <li
              key={order.id}
              className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link
                    href={`/admin/pedidos/${order.id}`}
                    className="text-base font-semibold text-indigo-600 hover:underline dark:text-indigo-400"
                  >
                    #{order.orderNumber}
                  </Link>
                  <p className="truncate text-sm text-zinc-900 dark:text-zinc-100">
                    {order.customerName}
                  </p>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    {order.itemsCount} {order.itemsCount === 1 ? "peça" : "peças"} ·{" "}
                    <Money cents={order.totalCents} /> · {paidAgo(order.paidAt)}
                    {order.paidAt ? (
                      <span className="block">{formatDateTimeSP(order.paidAt)}</span>
                    ) : null}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <Badge tone={order.status === "preparing" ? "info" : "warning"}>
                    {order.status === "preparing" ? "Em separação" : "Pago"}
                  </Badge>
                  {order.isGift ? <Badge tone="warning">🎁 Presente · sem preço</Badge> : null}
                </div>
              </div>
              <PackForm orderId={order.id} photoUrl={null} packedAtLabel={null} compact />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
