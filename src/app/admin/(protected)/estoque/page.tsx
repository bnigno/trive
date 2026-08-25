import type { Metadata } from "next";
import Link from "next/link";
import { getDb } from "@/db/client";
import { requireUser } from "@/services/auth";
import { getStockOverview } from "@/services/stock";
import { LowStockBadge } from "@/components/admin/low-stock-alert";
import { StatCard } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Button, Input } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { Table, Td, Tr } from "@/components/ui/table";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Estoque",
};

export default async function StockOverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  await requireUser();
  const params = await searchParams;
  const q = (Array.isArray(params.q) ? params.q[0] : params.q)?.trim() ?? "";

  const rows = await getStockOverview(getDb());

  const needle = q.toLowerCase();
  const filtered = q
    ? rows.filter(
        (row) =>
          row.productName.toLowerCase().includes(needle) ||
          row.sku.toLowerCase().includes(needle),
      )
    : rows;

  const totalSkus = rows.length;
  const outOfStock = rows.filter((row) => row.available <= 0).length;
  const belowThreshold = rows.filter(
    (row) => row.low && row.available > 0,
  ).length;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Estoque"
        subtitle="Acompanhe quanto você tem de cada item. Disponível = físico − reservado para pedidos."
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="SKUs em falta"
          value={outOfStock}
          tone={outOfStock > 0 ? "danger" : "neutral"}
          hint="Itens com disponível zerado"
        />
        <StatCard
          label="Abaixo do limiar"
          value={belowThreshold}
          tone={belowThreshold > 0 ? "warning" : "neutral"}
          hint="Perto de acabar — vale repor logo"
        />
        <StatCard label="Total de SKUs" value={totalSkus} hint="Itens ativos no catálogo" />
      </div>

      {totalSkus === 0 ? (
        <EmptyState
          title="Nenhum item de estoque ainda"
          hint="Cadastre seu primeiro produto para começar a controlar o estoque."
          action={
            <Link
              href="/admin/produtos/novo"
              className="inline-flex items-center justify-center rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
            >
              Cadastrar produto
            </Link>
          }
        />
      ) : (
        <div className="flex flex-col gap-4">
          <form
            action="/admin/estoque"
            method="get"
            className="flex w-full max-w-md items-center gap-2"
          >
            <Input
              name="q"
              defaultValue={q}
              placeholder="Buscar por produto ou SKU…"
              aria-label="Buscar por produto ou SKU"
            />
            <Button type="submit" variant="outline">
              Buscar
            </Button>
            {q ? (
              <Link
                href="/admin/estoque"
                className="whitespace-nowrap text-sm text-zinc-500 hover:underline dark:text-zinc-400"
              >
                Limpar
              </Link>
            ) : null}
          </form>

          {filtered.length === 0 ? (
            <EmptyState
              title={`Nenhum item encontrado para "${q}"`}
              hint="Confira a grafia ou busque por outro nome ou SKU."
              action={
                <Link
                  href="/admin/estoque"
                  className="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  Limpar busca
                </Link>
              }
            />
          ) : (
            <Table
              headers={[
                "Produto",
                "SKU",
                "Disponível",
                "Reservado",
                "Físico",
                "Limiar",
                "Situação",
              ]}
            >
              {filtered.map((row) => (
                <Tr key={row.variantId}>
                  <Td>
                    <Link
                      href={`/admin/estoque/${row.variantId}`}
                      className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                    >
                      {row.productName}
                    </Link>
                  </Td>
                  <Td className="font-mono text-xs">{row.sku}</Td>
                  <Td
                    className={
                      row.available <= 0
                        ? "font-semibold text-red-600 dark:text-red-400"
                        : row.low
                          ? "font-semibold text-amber-600 dark:text-amber-400"
                          : "font-semibold"
                    }
                  >
                    {row.available}
                  </Td>
                  <Td>{row.reserved}</Td>
                  <Td>{row.onHand}</Td>
                  <Td>{row.lowStockThreshold}</Td>
                  <Td>
                    <LowStockBadge
                      available={row.available}
                      threshold={row.lowStockThreshold}
                    />
                  </Td>
                </Tr>
              ))}
            </Table>
          )}
        </div>
      )}
    </div>
  );
}
