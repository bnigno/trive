import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { getDb } from "@/db/client";
import { requireUser } from "@/services/auth";
import { ServiceError } from "@/services/catalog";
import { getSupplierDetail } from "@/services/suppliers";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Money } from "@/components/ui/money";
import { PageHeader } from "@/components/ui/page-header";
import { StatusPill } from "@/components/ui/status-pill";
import { Table, Td, Tr } from "@/components/ui/table";
import { SupplierForm } from "../supplier-form";
import {
  dateTimeFormatter,
  formatDocumentBR,
  formatPhoneBR,
} from "../../clientes/format";
import { DeactivateSupplierForm, SettleEntryForm } from "./supplier-actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Fornecedor",
};

type Detail = Awaited<ReturnType<typeof getSupplierDetail>>;

type EntryStatus = "pending" | "settled" | "canceled";

const ENTRY_STATUS_LABELS: Record<EntryStatus, string> = {
  pending: "Pendente",
  settled: "Pago",
  canceled: "Cancelado",
};

const ENTRY_STATUS_TONES: Record<
  EntryStatus,
  "warning" | "success" | "neutral"
> = {
  pending: "warning",
  settled: "success",
  canceled: "neutral",
};

const PRODUCT_STATUS_LABELS: Record<string, string> = {
  draft: "Rascunho",
  active: "Ativo",
  archived: "Arquivado",
};

/** 'YYYY-MM-DD' → 'dd/mm/aaaa'. */
function formatDueDate(dueDate: string | null): string {
  if (!dueDate) return "—";
  const [year, month, day] = dueDate.split("-");
  return `${day}/${month}/${year}`;
}

export default async function SupplierDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireUser();
  const { id } = await params;

  const db = getDb();
  let detail: Detail;
  try {
    detail = await getSupplierDetail(db, id);
  } catch (error) {
    if (
      error instanceof z.ZodError ||
      (error instanceof ServiceError && error.code === "nao_encontrado")
    ) {
      notFound();
    }
    throw error;
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={detail.name}
        subtitle={`Fornecedor desde ${dateTimeFormatter.format(detail.createdAt)}`}
        actions={
          <Link
            href="/admin/fornecedores"
            className="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
          >
            ← Voltar para fornecedores
          </Link>
        }
      />

      <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
        <span>{formatPhoneBR(detail.phoneE164)}</span>
        <span aria-hidden>·</span>
        <span>{detail.email ?? "sem e-mail"}</span>
        <span aria-hidden>·</span>
        <span>
          {detail.documentType
            ? `${detail.documentType.toUpperCase()} ${formatDocumentBR(detail.documentType, detail.documentNumber)}`
            : "sem CPF/CNPJ"}
        </span>
        <span aria-hidden>·</span>
        <span>{detail.pixKey ? `Pix: ${detail.pixKey}` : "sem chave Pix"}</span>
      </div>

      <div className="grid items-start gap-6 xl:grid-cols-2">
        <div className="flex flex-col gap-6">
          <Card title="Dados do fornecedor">
            <SupplierForm
              initial={{
                id: detail.id,
                name: detail.name,
                contactName: detail.contactName ?? "",
                email: detail.email ?? "",
                phone: detail.phoneE164 ? formatPhoneBR(detail.phoneE164) : "",
                document: detail.documentNumber
                  ? formatDocumentBR(detail.documentType, detail.documentNumber)
                  : "",
                pixKey: detail.pixKey ?? "",
                notes: detail.notes ?? "",
              }}
            />
          </Card>

          <Card title="Produtos deste fornecedor">
            {detail.products.length === 0 ? (
              <EmptyState
                title="Nenhum produto vinculado a este fornecedor"
                hint="No cadastro do produto, escolha este fornecedor no campo Fornecedor."
              />
            ) : (
              <Table headers={["Produto", "Status"]}>
                {detail.products.map((product) => (
                  <Tr key={product.id}>
                    <Td>
                      <Link
                        href={`/admin/produtos/${product.id}`}
                        className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                      >
                        {product.name}
                      </Link>
                    </Td>
                    <Td>
                      {PRODUCT_STATUS_LABELS[product.status] ?? product.status}
                    </Td>
                  </Tr>
                ))}
              </Table>
            )}
          </Card>
        </div>

        <div className="flex flex-col gap-6">
          <Card title="Últimas compras">
            {detail.recentPurchases.length === 0 ? (
              <EmptyState
                title="Nenhuma compra registrada ainda"
                hint="Registre uma entrada de estoque escolhendo este fornecedor — ela aparece aqui com custo e conta a pagar."
              />
            ) : (
              <Table headers={["Data", "Produto", "Qtd", "Custo unit."]}>
                {detail.recentPurchases.map((purchase) => (
                  <Tr key={purchase.id}>
                    <Td className="whitespace-nowrap">
                      {dateTimeFormatter.format(purchase.createdAt)}
                    </Td>
                    <Td>
                      <Link
                        href={`/admin/estoque/${purchase.variantId}`}
                        className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                      >
                        {purchase.productName}
                      </Link>
                      <span className="ml-2 font-mono text-xs text-zinc-500 dark:text-zinc-400">
                        {purchase.sku}
                      </span>
                    </Td>
                    <Td>{purchase.quantity}</Td>
                    <Td className="whitespace-nowrap">
                      {purchase.unitCostCents !== null ? (
                        <Money cents={purchase.unitCostCents} />
                      ) : (
                        "—"
                      )}
                    </Td>
                  </Tr>
                ))}
              </Table>
            )}
          </Card>

          <Card title="Contas a pagar">
            {detail.payables.length === 0 ? (
              <EmptyState
                title="Nenhuma conta a pagar deste fornecedor"
                hint="Compras com fornecedor geram a conta aqui automaticamente; lançamentos manuais você cria no Financeiro."
              />
            ) : (
              <Table
                headers={["Descrição", "Valor", "Vencimento", "Status", "Ações"]}
              >
                {detail.payables.map((entry) => {
                  const entryStatus = entry.status as EntryStatus;
                  return (
                    <Tr key={entry.id}>
                      <Td className="max-w-64">
                        <span className="line-clamp-2">{entry.description}</span>
                      </Td>
                      <Td className="whitespace-nowrap font-medium text-red-600 dark:text-red-400">
                        −<Money cents={entry.amountCents} />
                      </Td>
                      <Td className="whitespace-nowrap">
                        {formatDueDate(entry.dueDate)}
                      </Td>
                      <Td>
                        <StatusPill
                          label={ENTRY_STATUS_LABELS[entryStatus] ?? entry.status}
                          tone={ENTRY_STATUS_TONES[entryStatus] ?? "neutral"}
                        />
                      </Td>
                      <Td>
                        {entryStatus === "pending" ? (
                          <SettleEntryForm
                            supplierId={detail.id}
                            entryId={entry.id}
                          />
                        ) : (
                          "—"
                        )}
                      </Td>
                    </Tr>
                  );
                })}
              </Table>
            )}
            <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
              Mostrando as 10 mais recentes.{" "}
              <Link
                href="/admin/financeiro"
                className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
              >
                Ver tudo no Financeiro
              </Link>
            </p>
          </Card>

          <div className="flex justify-end">
            <DeactivateSupplierForm supplierId={detail.id} />
          </div>
        </div>
      </div>
    </div>
  );
}
