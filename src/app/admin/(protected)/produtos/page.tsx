import type { Metadata } from "next";
import Link from "next/link";
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  categories,
  productImages,
  productVariants,
  stockLevels,
} from "@/db/schema";
import { getFileStorage } from "@/adapters/storage";
import { requireUser } from "@/services/auth";
import {
  listProducts,
  thumbPathFor,
  type ProductListItem,
} from "@/services/catalog";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Button, Input } from "@/components/ui/form";
import { Money } from "@/components/ui/money";
import { PageHeader } from "@/components/ui/page-header";
import { StatusPill } from "@/components/ui/status-pill";
import { Table, Td, Tr } from "@/components/ui/table";
import { cx } from "@/components/ui/cx";
import { OwnerOnly } from "../owner-only";
import { CategoryForm } from "./category-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Produtos",
};

const STATUS_FILTERS = [
  { value: "", label: "Todos" },
  { value: "draft", label: "Rascunhos" },
  { value: "active", label: "Ativos" },
  { value: "archived", label: "Arquivados" },
] as const;

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

function parseStatus(value: string): ProductStatus | undefined {
  return value === "draft" || value === "active" || value === "archived"
    ? value
    : undefined;
}

function listUrl(q: string, status: string): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (status) params.set("status", status);
  const query = params.toString();
  return query ? `/admin/produtos?${query}` : "/admin/produtos";
}

function PriceRange({ item }: { item: ProductListItem }) {
  if (item.minActivePriceCents === null || item.maxActivePriceCents === null) {
    return <span className="text-zinc-400 dark:text-zinc-500">Sem preço</span>;
  }
  if (item.minActivePriceCents === item.maxActivePriceCents) {
    return <Money cents={item.minActivePriceCents} />;
  }
  return (
    <span className="whitespace-nowrap">
      <Money cents={item.minActivePriceCents} /> –{" "}
      <Money cents={item.maxActivePriceCents} />
    </span>
  );
}

export default async function ProdutosPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  await requireUser();
  const params = await searchParams;
  const q = (params.q ?? "").trim();
  const statusParam = (params.status ?? "").trim();
  const status = parseStatus(statusParam);

  const db = getDb();
  const storage = getFileStorage();

  const [items, categoryRows] = await Promise.all([
    listProducts(db, { search: q || undefined, status }),
    db.select().from(categories).orderBy(asc(categories.name)),
  ]);

  // Leituras simples na page (permitido): primeira imagem de cada produto e
  // quais produtos têm alguma variação com estoque disponível <= limite.
  const thumbByProduct = new Map<string, string>();
  const lowStockProducts = new Set<string>();
  const productIds = items.map((item) => item.id);
  if (productIds.length > 0) {
    const [imageRows, lowStockRows] = await Promise.all([
      db
        .select({
          productId: productImages.productId,
          storagePath: productImages.storagePath,
        })
        .from(productImages)
        .where(inArray(productImages.productId, productIds))
        .orderBy(asc(productImages.sortOrder), asc(productImages.createdAt)),
      db
        .selectDistinct({ productId: productVariants.productId })
        .from(stockLevels)
        .innerJoin(
          productVariants,
          eq(productVariants.id, stockLevels.productVariantId),
        )
        .where(
          and(
            inArray(productVariants.productId, productIds),
            isNull(productVariants.deletedAt),
            lte(
              sql`${stockLevels.onHand} - ${stockLevels.reserved}`,
              stockLevels.lowStockThreshold,
            ),
          ),
        ),
    ]);
    for (const row of imageRows) {
      if (!thumbByProduct.has(row.productId)) {
        thumbByProduct.set(
          row.productId,
          storage.publicUrl(thumbPathFor(row.storagePath)),
        );
      }
    }
    for (const row of lowStockRows) {
      lowStockProducts.add(row.productId);
    }
  }

  const hasFilters = Boolean(q || status);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Produtos"
        subtitle="Tudo o que você vende: cadastre, edite e acompanhe estoque e preço."
        actions={
          // Cadastro de produto pede o custo inicial: área do dono.
          <OwnerOnly>
            <Link
              href="/admin/produtos/novo"
              className="inline-flex items-center rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
            >
              Novo produto
            </Link>
          </OwnerOnly>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <form
          method="get"
          action="/admin/produtos"
          className="flex min-w-64 flex-1 items-center gap-2 sm:max-w-md"
        >
          <Input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Buscar por nome, marca ou SKU"
            aria-label="Buscar produtos"
          />
          {statusParam ? (
            <input type="hidden" name="status" value={statusParam} />
          ) : null}
          <Button type="submit" variant="outline" className="shrink-0">
            Buscar
          </Button>
        </form>

        <div className="flex flex-wrap items-center gap-1">
          {STATUS_FILTERS.map((filter) => {
            const isCurrent = filter.value === (status ?? "");
            return (
              <Link
                key={filter.value || "todos"}
                href={listUrl(q, filter.value)}
                className={cx(
                  "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                  isCurrent
                    ? "bg-indigo-600 text-white"
                    : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800",
                )}
              >
                {filter.label}
              </Link>
            );
          })}
        </div>
      </div>

      {items.length === 0 ? (
        <EmptyState
          title={
            hasFilters
              ? "Nenhum produto encontrado com esses filtros."
              : "Você ainda não cadastrou nenhum produto."
          }
          hint={
            hasFilters
              ? "Tente mudar a busca ou o filtro de status."
              : "Comece cadastrando seu primeiro produto — leva menos de um minuto."
          }
          action={
            hasFilters ? (
              <Link
                href="/admin/produtos"
                className="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
              >
                Limpar filtros
              </Link>
            ) : (
              <OwnerOnly>
                <Link
                  href="/admin/produtos/novo"
                  className="inline-flex items-center rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
                >
                  Cadastrar primeiro produto
                </Link>
              </OwnerOnly>
            )
          }
        />
      ) : (
        <Table
          headers={[
            "",
            "Produto",
            "Variações",
            "Preço ativo",
            "Estoque",
            "Status",
          ]}
        >
          {items.map((item) => {
            const thumbUrl = thumbByProduct.get(item.id);
            const available = item.totalOnHand - item.totalReserved;
            const itemStatus = parseStatus(item.status);
            return (
              <Tr key={item.id}>
                <Td className="w-14">
                  {thumbUrl ? (
                     
                    <img
                      src={thumbUrl}
                      alt=""
                      className="h-10 w-10 rounded-md border border-zinc-200 object-cover dark:border-zinc-700"
                    />
                  ) : (
                    <span className="flex h-10 w-10 items-center justify-center rounded-md bg-zinc-100 text-sm font-semibold uppercase text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                      {item.name.charAt(0)}
                    </span>
                  )}
                </Td>
                <Td>
                  <Link
                    href={`/admin/produtos/${item.id}`}
                    className="font-medium text-zinc-900 hover:underline dark:text-zinc-100"
                  >
                    {item.name}
                  </Link>
                  {item.brand ? (
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      {item.brand}
                    </p>
                  ) : null}
                </Td>
                <Td>{item.variantCount}</Td>
                <Td>
                  <PriceRange item={item} />
                </Td>
                <Td>
                  <span className="mr-2">{available}</span>
                  {available <= 0 ? (
                    <Badge tone="danger">Esgotado</Badge>
                  ) : lowStockProducts.has(item.id) ? (
                    <Badge tone="warning">Estoque baixo</Badge>
                  ) : null}
                </Td>
                <Td>
                  {itemStatus ? (
                    <StatusPill
                      label={STATUS_LABELS[itemStatus]}
                      tone={STATUS_TONES[itemStatus]}
                    />
                  ) : (
                    <StatusPill label={item.status} tone="neutral" />
                  )}
                </Td>
              </Tr>
            );
          })}
        </Table>
      )}

      <Card title="Categorias">
        <div className="flex flex-col gap-4">
          {categoryRows.length === 0 ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Nenhuma categoria criada ainda. Categorias ajudam a organizar seus
              produtos.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {categoryRows.map((category) => (
                <Badge key={category.id} tone="info">
                  {category.name}
                </Badge>
              ))}
            </div>
          )}
          <OwnerOnly>
            <CategoryForm />
          </OwnerOnly>
        </div>
      </Card>
    </div>
  );
}
