import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { PriceBreakdownView } from "@/components/admin/price-breakdown";
import { EmptyState } from "@/components/ui/empty-state";
import { Money, MoneyDelta } from "@/components/ui/money";
import { PageHeader } from "@/components/ui/page-header";
import { StatusPill, priceStatusTone } from "@/components/ui/status-pill";
import { Table, Td, Tr } from "@/components/ui/table";
import type { PriceBreakdown } from "@/core/pricing";
import { getDb } from "@/db/client";
import { formatCentsBRL } from "@/lib/money";
import { products, productVariants, users } from "@/db/schema";
import { requireUser } from "@/services/auth";
import { listPriceVersions } from "@/services/pricing";
import {
  formatDateTime,
  formatPercent,
  translateOrigin,
  translatePriceStatus,
} from "../../labels";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Histórico de preços" };

const linkButtonClasses =
  "inline-flex items-center justify-center rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800";

function asBreakdown(value: unknown): PriceBreakdown | null {
  if (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as PriceBreakdown).steps) &&
    typeof (value as PriceBreakdown).output === "object"
  ) {
    return value as PriceBreakdown;
  }
  return null;
}

export default async function PriceHistoryPage({
  params,
}: {
  params: Promise<{ variantId: string }>;
}) {
  await requireUser();
  const { variantId } = await params;
  const parsed = z.uuid().safeParse(variantId);
  if (!parsed.success) notFound();

  const db = getDb();
  const [variant] = await db
    .select({
      sku: productVariants.sku,
      productName: products.name,
      costCents: productVariants.costCents,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(eq(productVariants.id, parsed.data))
    .limit(1);
  if (!variant) notFound();

  const versions = await listPriceVersions(db, parsed.data);

  const approverIds = [
    ...new Set(versions.flatMap((v) => (v.approvedBy ? [v.approvedBy] : []))),
  ];
  const approvers =
    approverIds.length > 0
      ? await db
          .select({
            id: users.id,
            fullName: users.fullName,
            email: users.email,
          })
          .from(users)
          .where(inArray(users.id, approverIds))
      : [];
  const approverName = new Map(
    approvers.map((u) => [u.id, u.fullName ?? u.email]),
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Histórico de preços"
        subtitle={`${variant.sku} — ${variant.productName} · custo atual ${formatCentsBRL(variant.costCents)}`}
        actions={
          <>
            <Link
              href={`/admin/precos/calculadora?variant=${parsed.data}`}
              className={linkButtonClasses}
            >
              Abrir calculadora
            </Link>
            <Link href="/admin/precos" className={linkButtonClasses}>
              Voltar para preços
            </Link>
          </>
        }
      />

      {versions.length === 0 ? (
        <EmptyState
          title="Nenhuma versão de preço ainda."
          hint="Use a calculadora para definir o primeiro preço desta variante."
          action={
            <Link
              href={`/admin/precos/calculadora?variant=${parsed.data}`}
              className={linkButtonClasses}
            >
              Definir preço
            </Link>
          }
        />
      ) : (
        <Table
          headers={[
            "Versão",
            "Status",
            "Preço",
            "Variação",
            "Margem",
            "Origem",
            "Aprovado por",
            "Quando",
          ]}
        >
          {versions.map((version) => {
            const breakdown = asBreakdown(version.breakdown);
            const manualNote =
              typeof (version.breakdown as { note?: unknown } | null)?.note ===
              "string"
                ? ((version.breakdown as { note: string }).note ?? null)
                : null;
            return [
              <Tr key={version.id}>
                <Td className="font-medium">v{version.versionNumber}</Td>
                <Td>
                  <StatusPill
                    label={translatePriceStatus(version.status)}
                    tone={priceStatusTone(version.status)}
                  />
                </Td>
                <Td>
                  <Money cents={version.priceCents} className="font-medium" />
                </Td>
                <Td>
                  {version.previousPriceCents !== null ? (
                    <MoneyDelta
                      cents={version.priceCents - version.previousPriceCents}
                    />
                  ) : (
                    "—"
                  )}
                </Td>
                <Td>{formatPercent(Number(version.computedMarginRate))}</Td>
                <Td>{translateOrigin(version.origin)}</Td>
                <Td>
                  {version.approvedBy
                    ? (approverName.get(version.approvedBy) ?? "—")
                    : "—"}
                </Td>
                <Td className="whitespace-nowrap">
                  {formatDateTime(version.createdAt)}
                </Td>
              </Tr>,
              <Tr key={`${version.id}-detalhes`}>
                <Td colSpan={8} className="bg-zinc-50/60 dark:bg-zinc-800/20">
                  <details>
                    <summary className="cursor-pointer text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400">
                      Ver a conta desta versão
                    </summary>
                    <div className="mt-3 flex max-w-2xl flex-col gap-3">
                      {breakdown ? (
                        <PriceBreakdownView breakdown={breakdown} />
                      ) : (
                        <p className="text-xs text-zinc-500 dark:text-zinc-400">
                          Esta versão não tem a conta detalhada registrada.
                        </p>
                      )}
                      {manualNote ? (
                        <p className="text-xs text-zinc-500 dark:text-zinc-400">
                          {manualNote}
                        </p>
                      ) : null}
                      <dl className="grid grid-cols-1 gap-1 text-xs text-zinc-500 dark:text-zinc-400 sm:grid-cols-2">
                        {version.approvedAt ? (
                          <div>
                            Aprovado em: {formatDateTime(version.approvedAt)}
                          </div>
                        ) : null}
                        {version.activatedAt ? (
                          <div>
                            Ativado em: {formatDateTime(version.activatedAt)}
                          </div>
                        ) : null}
                        {version.supersededAt ? (
                          <div>
                            Substituído em:{" "}
                            {formatDateTime(version.supersededAt)}
                          </div>
                        ) : null}
                        {version.rejectedAt ? (
                          <div>
                            Rejeitado em: {formatDateTime(version.rejectedAt)}
                            {version.rejectionReason
                              ? ` — motivo: ${version.rejectionReason}`
                              : ""}
                          </div>
                        ) : null}
                      </dl>
                    </div>
                  </details>
                </Td>
              </Tr>,
            ];
          })}
        </Table>
      )}
    </div>
  );
}
