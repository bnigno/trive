import type { Metadata } from "next";
import Link from "next/link";

import { Badge, type BadgeTone } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Money } from "@/components/ui/money";
import { PageHeader } from "@/components/ui/page-header";
import { Table, Td, Tr } from "@/components/ui/table";
import { TRAFFIC_LIGHT_LABELS, type TrafficLight } from "@/core/shipping/needed-by";
import { getDb } from "@/db/client";
import { requireUser } from "@/services/auth";
import { listOrdersWithNeededBy } from "@/services/needed-by";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Data marcada" };

const LIGHT_TONE: Record<TrafficLight, BadgeTone> = { red: "danger", amber: "warning", green: "success" };
const LIGHT_DOT: Record<TrafficLight, string> = { red: "bg-red-500", amber: "bg-amber-400", green: "bg-emerald-500" };

// Data marcada: os pedidos em que a cliente disse "preciso até o dia X",
// do mais urgente ao mais folgado, com o dia em que a peça precisa SAIR.
// Sem regra aqui: tudo vem de listOrdersWithNeededBy.
export default async function DataMarcadaPage() {
  await requireUser();
  const rows = await listOrdersWithNeededBy(getDb());
  const red = rows.filter((r) => r.light === "red" && !r.dispatched).length;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Data marcada"
        subtitle={rows.length === 0 ? "Pedidos com data combinada, do mais urgente ao mais folgado." : `${rows.length} ${rows.length === 1 ? "pedido" : "pedidos"} com data · ${red} ${red === 1 ? "precisa" : "precisam"} sair hoje`}
        actions={
          <Link href="/admin/pedidos" className="text-sm text-zinc-600 hover:underline dark:text-zinc-400">
            ← Todos os pedidos
          </Link>
        }
      />

      {rows.length === 0 ? (
        <EmptyState
          title="Nenhum pedido com data marcada por sair."
          hint="Quando a cliente marca “É para uma data?” no checkout, o pedido aparece aqui com o dia em que precisa sair."
        />
      ) : (
        <Table headers={["", "Pedido", "Cliente", "Para o dia", "Precisa sair", "Entrega", "Total"]}>
          {rows.map((row) => (
            <Tr key={row.id}>
              <Td>
                <span className={`inline-block h-3 w-3 rounded-full ${LIGHT_DOT[row.light]}`} aria-hidden="true" />
                <span className="sr-only">{TRAFFIC_LIGHT_LABELS[row.light]}</span>
              </Td>
              <Td>
                <Link href={`/admin/pedidos/${row.id}`} className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
                  #{row.orderNumber}
                </Link>
                <span className="block text-xs text-zinc-500">
                  {row.status === "pending_payment" ? "paga ao receber" : row.status === "preparing" ? "em separação" : "pago"}
                  {row.isGift ? " · 🎁" : ""}
                </span>
              </Td>
              <Td>{row.customerName}</Td>
              <Td>
                {row.neededByLabel.replace(/^Para o dia /, "")}
              </Td>
              <Td className="whitespace-nowrap">
                {row.dispatched ? <Badge tone="info">Já saiu</Badge> : <Badge tone={LIGHT_TONE[row.light]}>{row.shipByLabel}</Badge>}
              </Td>
              <Td className="whitespace-nowrap">{row.isMotoboy ? "Motoboy" : "Correios"}</Td>
              <Td className="tabular-nums">
                <Money cents={row.totalCents} />
              </Td>
            </Tr>
          ))}
        </Table>
      )}
    </div>
  );
}
