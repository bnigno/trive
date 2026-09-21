import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { requireOwner } from "@/services/auth";
import { getCouponReport } from "@/services/coupons";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Money } from "@/components/ui/money";
import { Table, Td, Tr } from "@/components/ui/table";
import { formatCouponValue, ORIGIN_LABELS } from "../labels";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Quem usou o cupom",
};

const dateTimeFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const STATUS_LABELS: Record<string, string> = {
  draft: "rascunho",
  pending_payment: "aguardando pagamento",
  paid: "pago",
  preparing: "preparando",
  shipped: "enviado",
  delivered: "entregue",
  canceled: "cancelado",
  refunded: "reembolsado",
};

export default async function CouponReportPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner("cupons");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const report = await getCouponReport(getDb(), id);
  if (!report) notFound();
  const { coupon, redemptions } = report;
  const active = redemptions.filter((row) => row.releasedAt === null);
  const totalDiscount = active.reduce((sum, row) => sum + row.discountCents + row.shippingDiscountCents, 0);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={`Cupom ${coupon.code}`}
        subtitle={`${formatCouponValue(coupon)} · ${ORIGIN_LABELS[coupon.origin]}${coupon.note ? ` · ${coupon.note}` : ""}`}
      />
      <p>
        <Link href="/admin/cupons" className="text-sm underline underline-offset-2 hover:text-indigo-600">
          ← Todos os cupons
        </Link>
      </p>

      <Card title="Quem usou">
        <div className="flex flex-col gap-4">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {active.length === 0
              ? "Ninguém usou este cupom ainda."
              : `${active.length} ${active.length === 1 ? "resgate ativo" : "resgates ativos"} · ${redemptions.length - active.length} devolvido(s) · `}
            {active.length > 0 ? (
              <>
                total concedido <Money cents={totalDiscount} />
              </>
            ) : null}
          </p>
          {redemptions.length === 0 ? (
            <EmptyState title="Nenhum resgate" hint="Quando uma cliente fechar um pedido com este cupom, ele aparece aqui." />
          ) : (
            <Table headers={["Pedido", "Cliente", "Quando", "Desconto", "Frete perdoado", "Status do pedido", ""]}>
              {redemptions.map((row) => (
                <Tr key={row.id} className={row.releasedAt ? "opacity-60" : undefined}>
                  <Td>
                    <Link href={`/admin/pedidos/${row.orderId}`} className="font-mono underline underline-offset-2 hover:text-indigo-600">
                      #{row.orderNumber}
                    </Link>
                  </Td>
                  <Td>
                    {row.customerId ? (
                      <Link href={`/admin/clientes/${row.customerId}`} className="underline underline-offset-2 hover:text-indigo-600">
                        {row.customerName ?? "Cliente"}
                      </Link>
                    ) : (
                      <span className="text-zinc-400">—</span>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap">{dateTimeFormatter.format(row.createdAt)}</Td>
                  <Td className="tabular-nums">
                    {row.discountCents > 0 ? <Money cents={row.discountCents} /> : "—"}
                    {row.appliedValue !== null && coupon.type === "percent" ? (
                      <span className="ml-1 text-xs text-zinc-500">({row.appliedValue}%)</span>
                    ) : null}
                  </Td>
                  <Td className="tabular-nums">{row.shippingDiscountCents > 0 ? <Money cents={row.shippingDiscountCents} /> : "—"}</Td>
                  <Td>{STATUS_LABELS[row.orderStatus] ?? row.orderStatus}</Td>
                  <Td>{row.releasedAt ? <Badge tone="warning">devolvido</Badge> : null}</Td>
                </Tr>
              ))}
            </Table>
          )}
        </div>
      </Card>
    </div>
  );
}
