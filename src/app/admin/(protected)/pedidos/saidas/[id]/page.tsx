import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { CopyField } from "@/components/ui/copy-field";
import { Money } from "@/components/ui/money";
import { PageHeader } from "@/components/ui/page-header";
import { signalAgeLabel } from "@/core/delivery/positions";
import { FAILURE_REASON_LABELS, RUN_STATUS_LABELS, STOP_STATUS_LABELS, isRunOpen } from "@/core/delivery/state";
import { getDb } from "@/db/client";
import { waMeUrl } from "@/lib/phone";
import { requireUser } from "@/services/auth";
import { getDeliveryRun } from "@/services/delivery-runs";

import { formatDateTimeSP } from "../../format";
import { CancelRunForm, FinishRunForm, ResendLinkForm } from "../forms";
import { RUN_TONE, STOP_TONE } from "../tones";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Saída do motoboy",
};

function mapsLink(point: { lat: number; lng: number }): string {
  return `https://www.google.com/maps?q=${point.lat.toFixed(6)},${point.lng.toFixed(6)}`;
}

// A saída: o motoboy, o link, cada parada com a prova (hora, quem recebeu,
// ponto do GPS) e os gestos do painel. O mapa ao vivo chega no próximo PR.
export default async function SaidaPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  const run = await getDeliveryRun(getDb(), id);
  if (!run) notFound();
  const now = new Date();
  const pending = run.stops.filter((stop) => stop.status === "pending").length;
  const open = isRunOpen(run.status);
  const courierWa = waMeUrl(run.courier.phoneE164);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={`Saída de ${run.courier.name}`}
        subtitle={`Montada em ${formatDateTimeSP(run.createdAt)}${run.startedAt ? ` · na rua desde ${formatDateTimeSP(run.startedAt)}` : ""}${run.finishedAt ? ` · encerrada ${formatDateTimeSP(run.finishedAt)}` : ""}${run.canceledAt ? ` · cancelada ${formatDateTimeSP(run.canceledAt)}` : ""}`}
        actions={
          <>
            <Badge tone={RUN_TONE[run.status]}>{RUN_STATUS_LABELS[run.status]}</Badge>
            <Link href="/admin/pedidos/saidas" className="text-sm text-zinc-600 hover:underline dark:text-zinc-400">
              ← Saídas
            </Link>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card title="Motoboy" className="lg:col-span-1">
          <div className="flex flex-col gap-3 text-sm">
            <p className="text-zinc-900 dark:text-zinc-100">
              {run.courier.name} <span className="text-zinc-500">· {run.courier.phoneE164}</span>
            </p>
            {courierWa ? (
              <a href={courierWa} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400">
                WhatsApp do motoboy
              </a>
            ) : null}
            {open ? (
              <>
                <CopyField label="Link da saída (só do motoboy)" value={run.courierUrl} hint="Ele já recebeu no WhatsApp. Copie só se precisar mandar por outro caminho." />
                <ResendLinkForm runId={run.id} courierName={run.courier.name} />
              </>
            ) : (
              <p className="text-xs text-zinc-500 dark:text-zinc-400">O link do motoboy parou de funcionar quando a saída fechou.</p>
            )}
            <div className="border-t border-zinc-200 pt-3 text-sm dark:border-zinc-800">
              <p className="text-zinc-500 dark:text-zinc-400">Último sinal do GPS</p>
              {run.lastPosition ? (
                <p className="text-zinc-900 dark:text-zinc-100">
                  {formatDateTimeSP(run.lastPosition.recordedAt)} <span className="text-zinc-500">({signalAgeLabel(run.lastPosition.recordedAt, now)})</span>
                  {" · "}
                  <a href={mapsLink(run.lastPosition)} target="_blank" rel="noopener noreferrer" className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
                    ver no mapa
                  </a>
                </p>
              ) : (
                <p className="text-zinc-900 dark:text-zinc-100">{run.status === "ready" ? 'Ainda não tocou em "Comecei a rota".' : "Nenhuma posição recebida."}</p>
              )}
            </div>
            {open ? (
              <div className="flex flex-wrap gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
                {run.status === "en_route" ? <FinishRunForm runId={run.id} pending={pending} /> : null}
                <CancelRunForm runId={run.id} pending={pending} />
              </div>
            ) : null}
          </div>
        </Card>

        <Card title={`Paradas · ${run.stops.length}`} className="lg:col-span-2">
          <ol className="flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800">
            {run.stops.map((stop) => (
              <li key={stop.id} className="flex flex-col gap-2 py-4 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                      {stop.sequence}.{" "}
                      <Link href={`/admin/pedidos/${stop.orderId}`} className="text-indigo-600 hover:underline dark:text-indigo-400">
                        #{stop.orderNumber}
                      </Link>{" "}
                      · {stop.customerName}
                    </p>
                    <p className="text-sm text-zinc-700 dark:text-zinc-300">{stop.addressLine ?? "Endereço não gravado"}</p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      {stop.windowLabel}
                      {stop.itemsCount ? ` · ${stop.itemsCount} ${stop.itemsCount === 1 ? "peça" : "peças"}` : ""}
                      {stop.isGift ? " · 🎁 presente" : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <Badge tone={STOP_TONE[stop.status]}>{STOP_STATUS_LABELS[stop.status]}</Badge>
                    {stop.collectCashCents !== null ? (
                      <Badge tone="warning">
                        receber <Money cents={stop.collectCashCents} /> em dinheiro
                      </Badge>
                    ) : null}
                  </div>
                </div>
                {stop.status === "delivered" ? (
                  <p className="text-sm text-emerald-800 dark:text-emerald-300">
                    Entregue {stop.deliveredAt ? formatDateTimeSP(stop.deliveredAt) : ""}
                    {stop.receivedBy ? `, recebido por ${stop.receivedBy}` : ""}
                    {stop.deliveredPoint ? (
                      <>
                        {" · "}
                        <a href={mapsLink(stop.deliveredPoint)} target="_blank" rel="noopener noreferrer" className="font-medium underline">
                          ponto do GPS
                        </a>
                        {stop.deliveredPoint.accuracyM !== null ? <span className="text-xs"> (±{Math.round(stop.deliveredPoint.accuracyM)} m)</span> : null}
                      </>
                    ) : (
                      <span className="text-xs text-zinc-500"> · sem ponto do GPS</span>
                    )}
                  </p>
                ) : null}
                {stop.status === "failed" ? (
                  <p className="text-sm text-red-700 dark:text-red-300">
                    Não entregue: {stop.failureReason ? FAILURE_REASON_LABELS[stop.failureReason] : "sem motivo"}
                    {stop.failureNote ? ` — "${stop.failureNote}"` : ""}. O pedido continua como saído: combine com a cliente e reagende na Rota do dia.
                  </p>
                ) : null}
                {stop.status === "canceled" ? <p className="text-xs text-zinc-500 dark:text-zinc-400">Parada cancelada junto com a saída.</p> : null}
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </div>
  );
}
