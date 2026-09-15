import type { Metadata } from "next";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Table, Td, Tr } from "@/components/ui/table";
import { RUN_STATUS_LABELS } from "@/core/delivery/state";
import { getDb } from "@/db/client";
import { requireUser } from "@/services/auth";
import { listDeliveryRuns } from "@/services/delivery-runs";

import { formatDateTimeSP } from "../format";
import { RUN_TONE } from "./tones";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Saídas do motoboy",
};

// Saídas do motoboy: as abertas primeiro pela ordem de criação; cada uma
// com quantas paradas já foram e quando o GPS falou pela última vez.
export default async function SaidasPage() {
  await requireUser();
  const runs = await listDeliveryRuns(getDb(), { limit: 100 });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Saídas do motoboy"
        subtitle="Cada saída é um motoboy com um grupo de pedidos. Monte uma nova na Rota do dia."
        actions={
          <>
            <Link href="/admin/pedidos/motoboys" className="text-sm text-zinc-600 hover:underline dark:text-zinc-400">
              Motoboys
            </Link>
            <Link href="/admin/pedidos/rota" className="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400">
              Rota do dia →
            </Link>
          </>
        }
      />

      {runs.length === 0 ? (
        <EmptyState title="Nenhuma saída ainda." hint="Na Rota do dia, marque os pedidos, escolha o motoboy e monte a primeira saída." />
      ) : (
        <Table headers={["Saída", "Motoboy", "Status", "Paradas", "Último sinal"]}>
          {runs.map((run) => (
            <Tr key={run.id}>
              <Td>
                <Link href={`/admin/pedidos/saidas/${run.id}`} className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
                  {formatDateTimeSP(run.createdAt)}
                </Link>
              </Td>
              <Td>{run.courierName}</Td>
              <Td>
                <Badge tone={RUN_TONE[run.status]}>{RUN_STATUS_LABELS[run.status]}</Badge>
              </Td>
              <Td>
                {run.stopsDelivered}/{run.stopsTotal} entregues
                {run.stopsFailed > 0 ? <span className="text-red-600 dark:text-red-400"> · {run.stopsFailed} não</span> : null}
              </Td>
              <Td>{run.lastPositionAt ? formatDateTimeSP(run.lastPositionAt) : "—"}</Td>
            </Tr>
          ))}
        </Table>
      )}
    </div>
  );
}
