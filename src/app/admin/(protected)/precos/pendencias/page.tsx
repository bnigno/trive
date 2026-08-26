import type { Metadata } from "next";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Money, MoneyDelta } from "@/components/ui/money";
import { PageHeader } from "@/components/ui/page-header";
import { Table, Td, Tr } from "@/components/ui/table";
import { formatCentsBRL } from "@/lib/money";
import { getDb } from "@/db/client";
import { requireOwner } from "@/services/auth";
import {
  listBatchSummary,
  listPendingApprovals,
  type BatchSummary,
} from "@/services/pricing";
import {
  formatDateTime,
  formatPercent,
  formatSignedPercent,
  translateOrigin,
  translateReason,
} from "../labels";
import { BatchActions } from "./batch-actions";
import { RowActions } from "./row-actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Pendências de preço" };

const linkButtonClasses =
  "inline-flex items-center justify-center rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800";

function RecalcBanner({
  sp,
}: {
  sp: Record<string, string | string[] | undefined>;
}) {
  if (typeof sp.lote !== "string") return null;
  const num = (key: string): number => {
    const value = typeof sp[key] === "string" ? Number(sp[key]) : NaN;
    return Number.isFinite(value) ? value : 0;
  };
  const criadas = num("criadas");
  const ativadas = num("ativadas");
  const pendentes = num("pendentes");
  const iguais = num("iguais");

  return (
    <p
      role="status"
      className="rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
    >
      Recálculo concluído: {criadas}{" "}
      {criadas === 1 ? "nova versão de preço" : "novas versões de preço"} —{" "}
      {ativadas} {ativadas === 1 ? "ativada" : "ativadas"} direto, {pendentes}{" "}
      aguardando aprovação e {iguais} sem mudança de preço.
    </p>
  );
}

function BatchCard({ batch }: { batch: BatchSummary }) {
  const { aggregate } = batch;
  return (
    <Card title={`Lote de recálculo ${batch.batchId.slice(0, 8)}`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <p className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            {aggregate.avgChangePct !== null
              ? formatSignedPercent(aggregate.avgChangePct)
              : "—"}{" "}
            em {aggregate.count} {aggregate.count === 1 ? "item" : "itens"}
          </p>
          <div>
            <Badge tone={aggregate.marginPreserved ? "success" : "danger"}>
              {aggregate.marginPreserved
                ? "Margem mínima preservada"
                : "Há itens abaixo da margem mínima"}
            </Badge>
          </div>
        </div>
        <BatchActions batchId={batch.batchId} count={aggregate.count} />
      </div>

      <Table
        headers={["SKU", "Atual", "Novo", "Variação", "Margem"]}
        className="mt-4"
      >
        {batch.items.map((item) => (
          <Tr key={item.versionId}>
            <Td>
              <Link
                href={`/admin/precos/historico/${item.variantId}`}
                className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
              >
                {item.sku}
              </Link>
            </Td>
            <Td>
              {item.currentPriceCents !== null ? (
                <Money cents={item.currentPriceCents} />
              ) : (
                "—"
              )}
            </Td>
            <Td>
              <Money cents={item.newPriceCents} className="font-medium" />
            </Td>
            <Td>
              {item.changePct !== null
                ? formatSignedPercent(item.changePct)
                : "—"}
            </Td>
            <Td>{formatPercent(item.computedMarginRate)}</Td>
          </Tr>
        ))}
      </Table>
    </Card>
  );
}

export default async function PendingApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireOwner("precos");
  const sp = await searchParams;
  const db = getDb();

  const items = await listPendingApprovals(db);
  const individual = items.filter((item) => item.batchId === null);
  const batchIds = [
    ...new Set(items.flatMap((item) => (item.batchId ? [item.batchId] : []))),
  ];
  const batches: BatchSummary[] = [];
  for (const batchId of batchIds) {
    batches.push(await listBatchSummary(db, batchId));
  }

  const isEmpty = individual.length === 0 && batches.length === 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Pendências de aprovação"
        subtitle="Mudanças críticas de preço só valem depois do seu OK."
        actions={
          <Link href="/admin/precos" className={linkButtonClasses}>
            Voltar para preços
          </Link>
        }
      />

      <RecalcBanner sp={sp} />

      {isEmpty ? (
        <EmptyState
          title="Nenhuma aprovação pendente — preços em dia."
          hint="Novas pendências aparecem aqui quando uma mudança de preço é crítica (queda, variação acima do limite ou margem baixa)."
          action={
            <Link href="/admin/precos" className={linkButtonClasses}>
              Ver visão geral de preços
            </Link>
          }
        />
      ) : (
        <>
          {batches.map((batch) => (
            <BatchCard key={batch.batchId} batch={batch} />
          ))}

          {individual.length > 0 ? (
            <section className="flex flex-col gap-3">
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                Pendências individuais
              </h2>
              <Table
                headers={[
                  "SKU",
                  "Atual → Novo",
                  "Margem",
                  "Motivos",
                  "Origem",
                  "Quando",
                  "Ações",
                ]}
              >
                {individual.map((item) => (
                  <Tr key={item.versionId}>
                    <Td>
                      <Link
                        href={`/admin/precos/historico/${item.variantId}`}
                        className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                      >
                        {item.sku}
                      </Link>
                      <p className="text-xs text-zinc-500 dark:text-zinc-400">
                        {item.productName}
                      </p>
                    </Td>
                    <Td>
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        {item.currentActivePriceCents !== null ? (
                          <>
                            <Money
                              cents={item.currentActivePriceCents}
                              className="text-zinc-500 dark:text-zinc-400"
                            />
                            <span className="text-zinc-400">→</span>
                          </>
                        ) : null}
                        <Money cents={item.priceCents} className="font-medium" />
                        {item.currentActivePriceCents !== null ? (
                          <MoneyDelta
                            cents={
                              item.priceCents - item.currentActivePriceCents
                            }
                            className="text-xs"
                          />
                        ) : null}
                      </div>
                    </Td>
                    <Td>{formatPercent(item.computedMarginRate)}</Td>
                    <Td>
                      <div className="flex max-w-52 flex-wrap gap-1">
                        {item.approvalReasons.map((reason) => (
                          <Badge key={reason} tone="warning">
                            {translateReason(reason)}
                          </Badge>
                        ))}
                      </div>
                    </Td>
                    <Td>{translateOrigin(item.origin)}</Td>
                    <Td className="whitespace-nowrap">
                      {formatDateTime(item.createdAt)}
                    </Td>
                    <Td>
                      <RowActions
                        versionId={item.versionId}
                        sku={item.sku}
                        priceLabel={formatCentsBRL(item.priceCents)}
                      />
                    </Td>
                  </Tr>
                ))}
              </Table>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
