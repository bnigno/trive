// "De onde vieram": por origem da ponte (página da peça, sacola, rodapé e
// cada link de story), no período escolhido, quantas tocaram em "Falar com
// a Lia", quantas chegaram à conversa, quantas fecharam pedido e quantas
// pagaram. Conta pontes (toques), não clientes distintas.
import type { Metadata } from "next";
import Link from "next/link";

import { Card, StatCard } from "@/components/ui/card";
import { cx } from "@/components/ui/cx";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Table, Td, Tr } from "@/components/ui/table";
import { getDb } from "@/db/client";
import { formatCentsBRL } from "@/lib/money";
import { requireOwner } from "@/services/auth";
import { siteBridgeFunnel, type BridgeFunnel } from "@/services/site-carts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "De onde vieram",
};

const PERIODS = [7, 30, 90] as const;
type Period = (typeof PERIODS)[number];
const DEFAULT_PERIOD: Period = 30;

function parsePeriod(raw: string | undefined): Period {
  const days = Number(raw);
  return (PERIODS as readonly number[]).includes(days) ? (days as Period) : DEFAULT_PERIOD;
}

/** Percentual inteiro de uma etapa sobre a anterior; "—" quando a anterior é zero. */
function rate(part: number, whole: number): string {
  if (whole === 0) return "—";
  return `${Math.round((part / whole) * 100)}%`;
}

async function loadFunnel(days: Period): Promise<BridgeFunnel | null> {
  try {
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    return await siteBridgeFunnel(getDb(), { from, to });
  } catch {
    return null;
  }
}

export default async function OrigensPage({ searchParams }: { searchParams: Promise<{ dias?: string }> }) {
  await requireOwner("whatsapp");
  const { dias } = await searchParams;
  const days = parsePeriod(dias);
  const funnel = await loadFunnel(days);

  const header = (
    <PageHeader
      title="De onde vieram"
      subtitle="Quem tocou em “Falar com a Lia” (no site ou num link de story), quantas chegaram à conversa e quantas compraram."
      actions={
        <div className="flex items-center gap-1 rounded-md border border-zinc-300 p-0.5 text-xs dark:border-zinc-700">
          {PERIODS.map((period) => (
            <Link
              key={period}
              href={`/admin/whatsapp/origens?dias=${period}`}
              aria-current={period === days ? "page" : undefined}
              className={cx(
                "rounded px-2.5 py-1 font-medium transition-colors",
                period === days
                  ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800",
              )}
            >
              {period} dias
            </Link>
          ))}
        </div>
      }
    />
  );

  if (!funnel) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <EmptyState
          title="Não foi possível carregar as origens"
          hint="O banco de dados está indisponível no momento. Tente recarregar a página."
        />
      </div>
    );
  }

  const { rows, totals } = funnel;

  return (
    <div className="flex flex-col gap-8">
      {header}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Toques" value={totals.taps} hint={`em ${days} dias`} />
        <StatCard
          label="Conversas"
          value={totals.conversations}
          hint={`${rate(totals.conversations, totals.taps)} dos toques`}
          tone={totals.conversations > 0 ? "success" : "neutral"}
        />
        <StatCard label="Pedidos" value={totals.orders} hint={`${rate(totals.orders, totals.conversations)} das conversas`} />
        <StatCard
          label="Pagos"
          value={totals.paidOrders}
          hint={formatCentsBRL(totals.paidCents)}
          tone={totals.paidOrders > 0 ? "success" : "neutral"}
        />
      </div>

      <Card title="Por origem">
        {rows.length === 0 ? (
          <EmptyState
            title={`Nenhum toque em ${days} dias`}
            hint="Quando alguém tocar em “Falar com a Lia” na página da peça, na sacola, no rodapé ou num link de story, aparece aqui."
          />
        ) : (
          <div className="flex flex-col gap-4">
            <Table headers={["Origem", "Toques", "Conversas", "Pedidos", "Pagos", "Vendido"]}>
              {rows.map((row) => (
                <Tr key={`${row.source}:${row.campaignSlug ?? ""}`}>
                  <Td>
                    <span className="font-medium text-zinc-900 dark:text-zinc-100">{row.label}</span>
                    {row.campaignSlug ? (
                      <span className="block font-mono text-xs text-zinc-500 dark:text-zinc-400">/ig/{row.campaignSlug}</span>
                    ) : null}
                  </Td>
                  <Td className="tabular-nums">{row.taps}</Td>
                  <Td className="tabular-nums">
                    {row.conversations}
                    <span className="ml-1 text-xs text-zinc-500">{rate(row.conversations, row.taps)}</span>
                  </Td>
                  <Td className="tabular-nums">{row.orders}</Td>
                  <Td className="tabular-nums">{row.paidOrders}</Td>
                  <Td className="whitespace-nowrap tabular-nums">{row.paidCents > 0 ? formatCentsBRL(row.paidCents) : "—"}</Td>
                </Tr>
              ))}
            </Table>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Toques contam cada vez que alguém abriu o WhatsApp pelo site (a mesma cliente pode contar duas vezes). Conversas = toques cuja mensagem chegou com o código. Pedidos = fechados nessas conversas, pagos ou não; <strong>Pagos</strong> é o que virou venda.
            </p>
            <div>
              <Link href="/admin/whatsapp/links" className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">
                Gerenciar links de story →
              </Link>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
