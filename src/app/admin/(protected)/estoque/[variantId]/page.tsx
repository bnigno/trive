import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import {
  orders,
  products,
  productVariants,
  stockLevels,
  suppliers,
} from "@/db/schema";
import { isOwner, requireUser } from "@/services/auth";
import { listMovements } from "@/services/stock";
import { listSuppliers } from "@/services/suppliers";
import { LowStockBadge } from "@/components/admin/low-stock-alert";
import { Card, StatCard } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Money } from "@/components/ui/money";
import { PageHeader } from "@/components/ui/page-header";
import { Table, Td, Tr } from "@/components/ui/table";
import { AdjustStockForm, ReceiveStockForm } from "./stock-forms";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Estoque do item",
};

const MOVEMENT_LABELS: Record<string, string> = {
  purchase_in: "Entrada",
  sale_out: "Venda",
  reservation: "Reserva",
  reservation_release: "Liberação de reserva",
  adjustment: "Ajuste",
  return_in: "Devolução",
  loss: "Perda",
};

const whenFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export default async function StockVariantPage({
  params,
}: {
  params: Promise<{ variantId: string }>;
}) {
  await requireUser();
  const owner = await isOwner();
  const { variantId } = await params;
  if (!z.uuid().safeParse(variantId).success) notFound();

  const db = getDb();

  // Leitura simples direta (sem função de serviço equivalente): dados da
  // variante + produto + saldos. Mutações ficam nas actions, via serviço.
  const [item] = await db
    .select({
      variantId: productVariants.id,
      sku: productVariants.sku,
      attributes: productVariants.attributes,
      isActive: productVariants.isActive,
      productId: products.id,
      productName: products.name,
      onHand: stockLevels.onHand,
      reserved: stockLevels.reserved,
      lowStockThreshold: stockLevels.lowStockThreshold,
    })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(stockLevels, eq(stockLevels.productVariantId, productVariants.id))
    .where(and(eq(productVariants.id, variantId), isNull(productVariants.deletedAt)))
    .limit(1);

  if (!item) notFound();

  const onHand = item.onHand ?? 0;
  const reserved = item.reserved ?? 0;
  const available = onHand - reserved;
  const threshold = item.lowStockThreshold ?? 3;

  const movements = await listMovements(db, { variantId, limit: 100 });

  // Fornecedores ativos para o select de entrada de compra. Compra é do dono:
  // para a equipe a lista nem é consultada.
  const supplierOptions = owner
    ? (await listSuppliers(db)).map((supplier) => ({
        id: supplier.id,
        name: supplier.name,
      }))
    : [];

  // Números dos pedidos referenciados, para o link "Pedido nº X".
  const orderIds = [
    ...new Set(
      movements
        .filter((m) => m.referenceType === "order" && m.referenceId !== null)
        .map((m) => m.referenceId as string),
    ),
  ];
  const orderNumberById = new Map<string, number>();
  if (orderIds.length > 0) {
    const orderRows = await db
      .select({ id: orders.id, orderNumber: orders.orderNumber })
      .from(orders)
      .where(inArray(orders.id, orderIds));
    for (const row of orderRows) orderNumberById.set(row.id, row.orderNumber);
  }

  // Nomes dos fornecedores referenciados no histórico (leitura direta, sem o
  // filtro de desativados: compras antigas podem apontar para inativos).
  const supplierRefIds = [
    ...new Set(
      movements
        .filter((m) => m.referenceType === "supplier" && m.referenceId !== null)
        .map((m) => m.referenceId as string),
    ),
  ];
  const supplierNameById = new Map<string, string>();
  if (supplierRefIds.length > 0) {
    const rows = await db
      .select({ id: suppliers.id, name: suppliers.name })
      .from(suppliers)
      .where(inArray(suppliers.id, supplierRefIds));
    for (const row of rows) supplierNameById.set(row.id, row.name);
  }

  const attributes = (item.attributes ?? {}) as Record<string, string>;
  const attributesText = Object.entries(attributes)
    .map(([key, value]) => `${key}: ${value}`)
    .join(" · ");

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={item.productName}
        subtitle={`SKU ${item.sku}${attributesText ? ` · ${attributesText}` : ""}`}
        actions={
          <div className="flex items-center gap-3">
            <LowStockBadge available={available} threshold={threshold} />
            <Link
              href={`/admin/produtos/${item.productId}`}
              className="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
            >
              Ver produto
            </Link>
            <Link
              href="/admin/estoque"
              className="text-sm text-zinc-500 hover:underline dark:text-zinc-400"
            >
              Voltar ao estoque
            </Link>
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Disponível"
          value={available}
          tone={available <= 0 ? "danger" : available <= threshold ? "warning" : "success"}
          hint={`Físico menos reservado — o que dá para vender. Alerta abaixo de ${threshold}.`}
        />
        <StatCard
          label="Reservado"
          value={reserved}
          hint="Separado para pedidos em aberto"
        />
        <StatCard label="Físico" value={onHand} hint="Unidades no seu estoque agora" />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Registrar entrada">
          <ReceiveStockForm
            variantId={item.variantId}
            supplierOptions={supplierOptions}
            canBuy={owner}
          />
        </Card>
        <Card title="Ajustar estoque">
          <AdjustStockForm variantId={item.variantId} />
        </Card>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          Histórico de movimentos
        </h2>
        {movements.length === 0 ? (
          <EmptyState
            title="Nenhum movimento registrado ainda"
            hint="Registre uma entrada acima para começar a controlar o estoque deste item."
          />
        ) : (
          <Table
            headers={
              // Custo unitário é dinheiro do negócio: coluna só para o dono.
              owner
                ? ["Data", "Tipo", "Quantidade", "Custo unit.", "Referência", "Nota"]
                : ["Data", "Tipo", "Quantidade", "Referência", "Nota"]
            }
          >
            {movements.map((movement) => (
              <Tr key={movement.id}>
                <Td className="whitespace-nowrap">
                  {whenFormatter.format(movement.createdAt)}
                </Td>
                <Td>{MOVEMENT_LABELS[movement.type] ?? movement.type}</Td>
                <Td
                  className={
                    movement.quantityDelta > 0
                      ? "font-semibold text-emerald-600 dark:text-emerald-400"
                      : "font-semibold text-red-600 dark:text-red-400"
                  }
                >
                  {movement.quantityDelta > 0
                    ? `+${movement.quantityDelta}`
                    : movement.quantityDelta}
                </Td>
                {owner ? (
                  <Td>
                    {movement.unitCostCents !== null ? (
                      <Money cents={movement.unitCostCents} />
                    ) : (
                      "—"
                    )}
                  </Td>
                ) : null}
                <Td>
                  {movement.referenceType === "order" && movement.referenceId ? (
                    <Link
                      href={`/admin/pedidos/${movement.referenceId}`}
                      className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                    >
                      {orderNumberById.has(movement.referenceId)
                        ? `Pedido nº ${orderNumberById.get(movement.referenceId)}`
                        : "Ver pedido"}
                    </Link>
                  ) : movement.referenceType === "supplier" &&
                    movement.referenceId ? (
                    // Fornecedores é área do dono: para a equipe o nome vira
                    // texto, senão o link levaria direto para o "sem acesso".
                    owner ? (
                      <Link
                        href={`/admin/fornecedores/${movement.referenceId}`}
                        className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                      >
                        {supplierNameById.get(movement.referenceId) ??
                          "Ver fornecedor"}
                      </Link>
                    ) : (
                      (supplierNameById.get(movement.referenceId) ??
                      "Fornecedor")
                    )
                  ) : (
                    "—"
                  )}
                </Td>
                <Td className="max-w-xs">{movement.note ?? "—"}</Td>
              </Tr>
            ))}
          </Table>
        )}
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          O histórico é permanente: cada entrada, venda, reserva e ajuste fica
          registrado aqui para sempre — nada é apagado.
        </p>
      </section>
    </div>
  );
}
