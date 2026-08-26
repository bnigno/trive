import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { asc } from "drizzle-orm";
import { getDb } from "@/db/client";
import { categories } from "@/db/schema";
import { getFileStorage } from "@/adapters/storage";
import { requireUser } from "@/services/auth";
import { getProductDetail, thumbPathFor } from "@/services/catalog";
import { listSuppliers } from "@/services/suppliers";
import { LowStockBadge } from "@/components/admin/low-stock-alert";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/form";
import { Money } from "@/components/ui/money";
import { PageHeader } from "@/components/ui/page-header";
import { StatusPill } from "@/components/ui/status-pill";
import { Table, Td, Tr } from "@/components/ui/table";
import { removeImageAction, setProductStatusAction } from "./actions";
import { EditProductForm } from "./edit-product-form";
import { ImageUploadForm } from "./image-upload-form";
import { AddVariantForm, EditVariantForm } from "./variant-forms";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Produto",
};

type ProductStatus = "draft" | "active" | "archived";

const STATUS_LABELS: Record<ProductStatus, string> = {
  draft: "Rascunho",
  active: "Ativo",
  archived: "Arquivado",
};

const STATUS_TONES: Record<ProductStatus, "warning" | "success" | "neutral"> = {
  draft: "warning",
  active: "success",
  archived: "neutral",
};

const STATUS_HINTS: Record<ProductStatus, string> = {
  draft: "Rascunho: o produto ainda não aparece na loja.",
  active: "Ativo: o produto aparece na loja e pode ser vendido.",
  archived:
    "Arquivado: o produto saiu do catálogo, mas pedidos antigos continuam mostrando ele normalmente.",
};

const dateTimeFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function formatAttributes(attributes: Record<string, string>): string {
  const entries = Object.entries(attributes);
  if (entries.length === 0) return "—";
  return entries.map(([key, value]) => `${key}: ${value}`).join(" · ");
}

export default async function ProdutoDetalhePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireUser();
  const { id } = await params;

  const db = getDb();
  let detail: Awaited<ReturnType<typeof getProductDetail>>;
  try {
    detail = await getProductDetail(db, id);
  } catch {
    // Id inválido ou produto não encontrado.
    notFound();
  }

  const categoryRows = await db
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .orderBy(asc(categories.name));

  const supplierRows = await listSuppliers(db);
  const supplierOptions = supplierRows.map((supplier) => ({
    id: supplier.id,
    name: supplier.name,
  }));

  const storage = getFileStorage();
  const status = (
    detail.status === "active" || detail.status === "archived"
      ? detail.status
      : "draft"
  ) as ProductStatus;
  const axes = Array.isArray(detail.attributesSchema)
    ? detail.attributesSchema.filter(
        (axis): axis is string => typeof axis === "string",
      )
    : [];

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <PageHeader
        title={detail.name}
        subtitle={`Criado em ${dateTimeFormatter.format(detail.createdAt)}`}
        actions={
          <Link
            href="/admin/produtos"
            className="text-sm font-medium text-zinc-600 hover:underline dark:text-zinc-400"
          >
            Voltar para produtos
          </Link>
        }
      />

      <Card title="Status">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <StatusPill
              label={STATUS_LABELS[status]}
              tone={STATUS_TONES[status]}
            />
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              {STATUS_HINTS[status]}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {status !== "active" ? (
              <form action={setProductStatusAction}>
                <input type="hidden" name="productId" value={detail.id} />
                <input type="hidden" name="status" value="active" />
                <Button type="submit" size="sm">
                  Ativar produto
                </Button>
              </form>
            ) : null}
            {status !== "draft" ? (
              <form action={setProductStatusAction}>
                <input type="hidden" name="productId" value={detail.id} />
                <input type="hidden" name="status" value="draft" />
                <Button type="submit" variant="outline" size="sm">
                  Voltar para rascunho
                </Button>
              </form>
            ) : null}
            {status !== "archived" ? (
              <form action={setProductStatusAction}>
                <input type="hidden" name="productId" value={detail.id} />
                <input type="hidden" name="status" value="archived" />
                <ConfirmButton
                  size="sm"
                  confirmMessage="Arquivar este produto? Ele sai do catálogo e não pode mais ser vendido, mas pedidos antigos continuam mostrando ele normalmente. Você pode reativá-lo quando quiser."
                >
                  Arquivar
                </ConfirmButton>
              </form>
            ) : null}
          </div>
        </div>
      </Card>

      <Card title="Dados básicos">
        <EditProductForm
          product={{
            id: detail.id,
            name: detail.name,
            description: detail.description,
            brand: detail.brand,
            categoryId: detail.categoryId,
            supplierId: detail.supplierId,
            attributesSchema: axes,
          }}
          categoryOptions={categoryRows}
          supplierOptions={supplierOptions}
        />
      </Card>

      <Card title="Imagens">
        <div className="flex flex-col gap-4">
          {detail.images.length === 0 ? (
            <EmptyState
              title="Este produto ainda não tem imagens."
              hint="Envie fotos do produto — a primeira vira a imagem principal na lista."
            />
          ) : (
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
              {detail.images.map((image) => (
                <div key={image.id} className="flex flex-col gap-2">
                  <a
                    href={storage.publicUrl(image.storagePath)}
                    target="_blank"
                    rel="noreferrer"
                    title="Abrir imagem em tamanho grande"
                  >
                    { }
                    <img
                      src={storage.publicUrl(thumbPathFor(image.storagePath))}
                      alt={image.altText ?? ""}
                      className="aspect-square w-full rounded-md border border-zinc-200 object-cover dark:border-zinc-700"
                    />
                  </a>
                  <form action={removeImageAction}>
                    <input type="hidden" name="imageId" value={image.id} />
                    <input type="hidden" name="productId" value={detail.id} />
                    <ConfirmButton
                      size="sm"
                      variant="outline"
                      className="w-full"
                      confirmMessage="Remover esta imagem? Esta ação não pode ser desfeita."
                    >
                      Remover
                    </ConfirmButton>
                  </form>
                </div>
              ))}
            </div>
          )}
          <ImageUploadForm productId={detail.id} />
        </div>
      </Card>

      <Card title="Variações">
        <div className="flex flex-col gap-5">
          {detail.variants.length === 0 ? (
            <EmptyState
              title="Este produto não tem variações."
              hint="Adicione ao menos uma variação para controlar estoque e preço."
            />
          ) : (
            <Table
              headers={[
                "SKU",
                "Atributos",
                "Custo",
                "Preço ativo",
                "Estoque",
                "Ações",
              ]}
            >
              {detail.variants.map((variant) => (
                <Tr key={variant.id}>
                  <Td className="font-mono text-xs">
                    {variant.sku}
                    {!variant.isActive ? (
                      <Badge tone="neutral" className="ml-2">
                        Inativa
                      </Badge>
                    ) : null}
                  </Td>
                  <Td>{formatAttributes(variant.attributes)}</Td>
                  <Td>
                    <Money cents={variant.costCents} />
                  </Td>
                  <Td>
                    {variant.activePriceCents !== null ? (
                      <Money cents={variant.activePriceCents} />
                    ) : (
                      <span className="text-zinc-400 dark:text-zinc-500">
                        Sem preço
                      </span>
                    )}
                  </Td>
                  <Td>
                    <span className="mr-2">{variant.available}</span>
                    <LowStockBadge
                      available={variant.available}
                      threshold={variant.lowStockThreshold ?? 0}
                    />
                  </Td>
                  <Td>
                    <div className="flex gap-3 whitespace-nowrap">
                      <Link
                        href={`/admin/precos/calculadora?variant=${variant.id}`}
                        className="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                      >
                        Precificar
                      </Link>
                      <Link
                        href={`/admin/estoque/${variant.id}`}
                        className="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                      >
                        Estoque
                      </Link>
                    </div>
                  </Td>
                </Tr>
              ))}
            </Table>
          )}

          {detail.variants.length > 0 ? (
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                Editar variações
              </h3>
              {detail.variants.map((variant) => (
                <details
                  key={variant.id}
                  className="rounded-md border border-zinc-200 dark:border-zinc-800"
                >
                  <summary className="cursor-pointer px-4 py-2 text-sm text-zinc-700 dark:text-zinc-300">
                    <span className="font-mono text-xs">{variant.sku}</span>
                    <span className="ml-2 text-zinc-500 dark:text-zinc-400">
                      {formatAttributes(variant.attributes)}
                    </span>
                  </summary>
                  <div className="border-t border-zinc-200 p-4 dark:border-zinc-800">
                    {axes.length > 0 ||
                    Object.keys(variant.attributes).length > 0 ? (
                      <EditVariantForm
                        productId={detail.id}
                        variant={variant}
                        axes={axes}
                      />
                    ) : (
                      <p className="text-sm text-zinc-500 dark:text-zinc-400">
                        Esta variação não tem atributos para editar. O SKU (
                        <span className="font-mono text-xs">{variant.sku}</span>
                        ) não pode ser alterado depois de criado.
                      </p>
                    )}
                  </div>
                </details>
              ))}
            </div>
          ) : null}

          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              Adicionar variação
            </h3>
            <AddVariantForm productId={detail.id} axes={axes} />
          </div>
        </div>
      </Card>
    </div>
  );
}
