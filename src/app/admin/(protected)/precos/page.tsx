import type { Metadata } from "next";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Button, Input } from "@/components/ui/form";
import { Money } from "@/components/ui/money";
import { PageHeader } from "@/components/ui/page-header";
import { Table, Td, Tr } from "@/components/ui/table";
import { getDb } from "@/db/client";
import { requireUser } from "@/services/auth";
import { listPricesOverview } from "@/services/pricing";
import { formatPercent } from "./labels";
import { RecalcButton } from "./recalc-button";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Preços" };

const linkButtonClasses =
  "inline-flex items-center justify-center rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800";

export default async function PricesOverviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const sp = await searchParams;
  const query = (typeof sp.q === "string" ? sp.q : "").trim();

  const db = getDb();
  const rows = await listPricesOverview(db);

  const needle = query.toLowerCase();
  const filtered = needle
    ? rows.filter(
        (row) =>
          row.sku.toLowerCase().includes(needle) ||
          row.productName.toLowerCase().includes(needle),
      )
    : rows;
  const pendingTotal = rows.reduce((sum, row) => sum + row.pendingCount, 0);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Preços"
        subtitle="Custo, preço ativo e margem de cada variante — tudo em um lugar."
        actions={
          <>
            <Link href="/admin/precos/calculadora" className={linkButtonClasses}>
              Calculadora
            </Link>
            <RecalcButton />
          </>
        }
      />

      {pendingTotal > 0 ? (
        <Link
          href="/admin/precos/pendencias"
          className="block rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 transition-colors hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300 dark:hover:bg-amber-900"
        >
          {pendingTotal === 1
            ? "1 preço aguarda a sua aprovação"
            : `${pendingTotal} preços aguardam a sua aprovação`}{" "}
          — clique para revisar.
        </Link>
      ) : null}

      <form method="get" className="flex w-full max-w-md items-center gap-2">
        <Input
          type="search"
          name="q"
          defaultValue={query}
          placeholder="Buscar por SKU ou produto…"
          aria-label="Buscar por SKU ou produto"
        />
        <Button type="submit" variant="outline">
          Buscar
        </Button>
      </form>

      {rows.length === 0 ? (
        <EmptyState
          title="Nenhuma variante ativa por aqui."
          hint="Cadastre um produto para começar a precificar."
          action={
            <Link href="/admin/produtos/novo" className={linkButtonClasses}>
              Cadastrar produto
            </Link>
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          title={`Nenhum resultado para “${query}”.`}
          hint="Tente buscar por outra parte do SKU ou do nome do produto."
          action={
            <Link href="/admin/precos" className={linkButtonClasses}>
              Limpar busca
            </Link>
          }
        />
      ) : (
        <Table
          headers={["SKU", "Produto", "Custo", "Preço ativo", "Margem", "Status"]}
        >
          {filtered.map((row) => (
            <Tr key={row.variantId}>
              <Td>
                <Link
                  href={`/admin/precos/historico/${row.variantId}`}
                  className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  {row.sku}
                </Link>
              </Td>
              <Td>{row.productName}</Td>
              <Td>
                <Money cents={row.costCents} />
              </Td>
              <Td>
                {row.activePriceCents !== null ? (
                  <Money cents={row.activePriceCents} className="font-medium" />
                ) : (
                  <span className="text-zinc-400 dark:text-zinc-500">—</span>
                )}
              </Td>
              <Td>
                {row.activeMarginRate !== null
                  ? formatPercent(row.activeMarginRate)
                  : "—"}
              </Td>
              <Td>
                {row.pendingCount > 0 ? (
                  <Link href="/admin/precos/pendencias">
                    <Badge tone="warning">
                      {row.pendingCount === 1
                        ? "1 pendência"
                        : `${row.pendingCount} pendências`}
                    </Badge>
                  </Link>
                ) : row.activePriceCents === null ? (
                  <Link
                    href={`/admin/precos/calculadora?variant=${row.variantId}`}
                  >
                    <Badge tone="neutral">Sem preço — definir</Badge>
                  </Link>
                ) : (
                  <Badge tone="success">Em dia</Badge>
                )}
              </Td>
            </Tr>
          ))}
        </Table>
      )}
    </div>
  );
}
