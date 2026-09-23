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
import { getLiaReadinessSummary, listProductReadiness } from "@/services/catalog-readiness";
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
import {
  CategoryCoverFocusForm,
  CategoryCoverForm,
  RemoveCategoryCoverForm,
} from "./category-cover-form";
import { CategoryForm } from "./category-form";
import { LiaIssueLinks, ReadinessBadge } from "./readiness-badge";
import { RestoreProductForm } from "./restore-form";
import { formatDateTimeSP } from "@/emails/templates";
import { LIA_ISSUES, LIA_READINESS_CODES, type LiaReadinessCode } from "@/core/catalog/readiness";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Produtos",
};

// "Excluídas" não é um status da peça, é o outro lado da lista: as peças com
// deleted_at, que nenhum dos outros filtros mostra.
const DELETED_FILTER = "excluidas";

const STATUS_FILTERS = [
  { value: "", label: "Todos" },
  { value: "draft", label: "Rascunhos" },
  { value: "active", label: "Ativos" },
  { value: "archived", label: "Arquivados" },
  { value: DELETED_FILTER, label: "Excluídas" },
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

type ReadinessFilter = "faltando" | "pronta";

const READINESS_FILTERS: { value: ReadinessFilter; label: string }[] = [
  { value: "faltando", label: "Faltando algo" },
  { value: "pronta", label: "Prontas" },
];

function parseReadinessFilter(value: string): ReadinessFilter | undefined {
  return value === "faltando" || value === "pronta" ? value : undefined;
}

function listUrl(q: string, status: string, prontidao = "", lia = ""): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (status) params.set("status", status);
  if (prontidao) params.set("prontidao", prontidao);
  if (lia) params.set("lia", lia);
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
  searchParams: Promise<{
    q?: string;
    status?: string;
    prontidao?: string;
    lia?: string;
    excluida?: string;
    arquivos?: string;
  }>;
}) {
  await requireUser();
  const params = await searchParams;
  const q = (params.q ?? "").trim();
  const statusParam = (params.status ?? "").trim();
  const showDeleted = statusParam === DELETED_FILTER;
  const status = parseStatus(statusParam);
  // Recado de quem acabou de excluir (a action redireciona para cá).
  const justDeleted = (params.excluida ?? "").trim();
  const orphanFiles = Number.parseInt(params.arquivos ?? "", 10);
  const readinessParam = (params.prontidao ?? "").trim();
  const readinessFilter = parseReadinessFilter(readinessParam);
  const liaParam = (params.lia ?? "").trim();
  const liaFilter = (LIA_READINESS_CODES as readonly string[]).includes(liaParam) ? (liaParam as LiaReadinessCode) : null;

  const db = getDb();
  const storage = getFileStorage();

  const [allItems, categoryRows] = await Promise.all([
    listProducts(db, {
      search: q || undefined,
      status,
      ...(showDeleted ? { deleted: true } : {}),
    }),
    db.select().from(categories).orderBy(asc(categories.name)),
  ]);
  const [readiness, liaSummary] = await Promise.all([
    listProductReadiness(db, { productIds: allItems.map((item) => item.id) }),
    getLiaReadinessSummary(db),
  ]);
  // "Faltando algo" = quase pronta ou bloqueada; arquivadas ficam fora dos dois chips.
  const items = allItems.filter((item) => {
    if (liaFilter && !readiness.get(item.id)?.lia.some((issue) => issue.code === liaFilter)) return false;
    if (!readinessFilter) return true;
    const level = readiness.get(item.id)?.level;
    return readinessFilter === "pronta"
      ? level === "ready"
      : level === "almost" || level === "blocked";
  });

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

  const hasFilters = Boolean(q || status || showDeleted || readinessFilter || liaFilter);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Produtos"
        subtitle="Tudo o que você vende: cadastre, edite e acompanhe estoque e preço."
        actions={
          <div className="flex items-center gap-4">
            {/* O selo é tarefa de embalagem: toda a equipe imprime. */}
            <Link href="/admin/produtos/selos" className="text-sm font-medium text-zinc-700 underline dark:text-zinc-300">
              Embalagem: selos e adesivos
            </Link>
            {/* Cadastro de produto e as chegadas (custo, conta a pagar): área do dono. */}
            <OwnerOnly>
              <Link href="/admin/produtos/chegadas" className="text-sm font-medium text-zinc-700 underline dark:text-zinc-300">
                Chegadas pelo WhatsApp
              </Link>
              <Link href="/admin/produtos/quem-vestiu" className="text-sm font-medium text-zinc-700 underline dark:text-zinc-300">
                Quem já vestiu
              </Link>
              <Link href="/admin/produtos/modelos-da-casa" className="text-sm font-medium text-zinc-700 underline dark:text-zinc-300">
                Modelos da casa
              </Link>
              <Link
                href="/admin/produtos/novo"
                className="inline-flex items-center rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
              >
                Novo produto
              </Link>
            </OwnerOnly>
          </div>
        }
      />

      {/* A ficha da Lia (composição, como veste, nota, tipo) mora em cards só do dono: staff não vê o card nem os links. */}
      <OwnerOnly>
      {liaSummary.complete < liaSummary.total ? (
        <section
          className="rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/30"
          data-lia-summary=""
        >
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">O que falta para a Lia falar bem das peças</h2>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
            A Lia só fala do que está na ficha: {liaSummary.complete} de {liaSummary.total} peças estão completas.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {LIA_READINESS_CODES.filter((code) => liaSummary.byCode[code] > 0).map((code) => (
              <Link
                key={code}
                href={liaFilter === code ? listUrl(q, statusParam, readinessFilter) : listUrl(q, statusParam, readinessFilter, code)}
                className={`rounded-full border px-3 py-1 text-xs ${
                  liaFilter === code
                    ? "border-amber-600 bg-amber-600 text-white"
                    : "border-amber-300 bg-white text-zinc-700 hover:bg-amber-100 dark:border-amber-800 dark:bg-zinc-900 dark:text-zinc-200"
                }`}
              >
                {LIA_ISSUES[code].label.replace(/ \(.*\)$/, "")} · {liaSummary.byCode[code]}
              </Link>
            ))}
          </div>
        </section>
      ) : null}
      </OwnerOnly>

      {liaFilter ? (
        <p className="text-xs text-zinc-600 dark:text-zinc-300" data-lia-filter="">
          Filtro ativo: {LIA_ISSUES[liaFilter].label.replace(/ \(.*\)$/, "")} ·{" "}
          <Link href={listUrl(q, statusParam, readinessFilter)} className="underline">
            limpar
          </Link>
        </p>
      ) : null}

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
          {readinessFilter ? (
            <input type="hidden" name="prontidao" value={readinessFilter} />
          ) : null}
          {liaFilter ? <input type="hidden" name="lia" value={liaFilter} /> : null}
          <Button type="submit" variant="outline" className="shrink-0">
            Buscar
          </Button>
        </form>

        <div className="flex flex-wrap items-center gap-1">
          {STATUS_FILTERS.map((filter) => {
            const isCurrent =
              filter.value === (showDeleted ? DELETED_FILTER : (status ?? ""));
            return (
              <Link
                key={filter.value || "todos"}
                href={listUrl(q, filter.value, readinessFilter, liaFilter ?? "")}
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
          {/* Prontidão é sobre vender: peça excluída não vende. */}
          {showDeleted ? null : (
            <span className="mx-1 hidden h-4 w-px bg-zinc-200 sm:block dark:bg-zinc-700" />
          )}
          {(showDeleted ? [] : READINESS_FILTERS).map((filter) => {
            const isCurrent = filter.value === readinessFilter;
            return (
              <Link
                key={filter.value}
                href={listUrl(q, statusParam, isCurrent ? "" : filter.value, liaFilter ?? "")}
                className={cx(
                  "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                  isCurrent
                    ? "bg-amber-600 text-white"
                    : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800",
                )}
              >
                {filter.label}
              </Link>
            );
          })}
        </div>
      </div>

      {justDeleted ? (
        <p
          role="status"
          className="rounded-md border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
        >
          «{justDeleted}» foi excluída. Ela está aqui embaixo e pode voltar
          enquanto você quiser.
          {Number.isFinite(orphanFiles) && orphanFiles > 0
            ? ` (${orphanFiles} arquivo(s) de foto não saíram do armazenamento; a peça saiu do ar mesmo assim.)`
            : ""}
        </p>
      ) : null}

      {showDeleted ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Peças excluídas não aparecem na loja, na Lia, nas buscas nem nas
          outras listas. Restaurar traz a peça de volta como rascunho — sem as
          fotos, que foram apagadas.
        </p>
      ) : null}

      {items.length === 0 ? (
        <EmptyState
          title={
            showDeleted
              ? "Nenhuma peça excluída."
              : hasFilters
                ? "Nenhum produto encontrado com esses filtros."
                : "Você ainda não cadastrou nenhum produto."
          }
          hint={
            showDeleted
              ? "Quando você excluir uma peça, ela fica guardada aqui."
              : hasFilters
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
                  {/* A ficha da peça excluída dá 404 de propósito: aqui ela é
                      só um nome para reconhecer e restaurar. */}
                  {showDeleted ? (
                    <span className="font-medium text-zinc-500 dark:text-zinc-400">
                      {item.name}
                    </span>
                  ) : (
                    <Link
                      href={`/admin/produtos/${item.id}`}
                      className="font-medium text-zinc-900 hover:underline dark:text-zinc-100"
                    >
                      {item.name}
                    </Link>
                  )}
                  {item.brand ? (
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      {item.brand}
                    </p>
                  ) : null}
                  {/* O selo mora embaixo do nome: no celular, a última coluna fica fora da tela. */}
                  {showDeleted ? null : (
                    <div className="mt-1">
                      <ReadinessBadge productId={item.id} readiness={readiness.get(item.id)} />
                      <OwnerOnly>
                        <LiaIssueLinks productId={item.id} issues={readiness.get(item.id)?.lia ?? []} />
                      </OwnerOnly>
                    </div>
                  )}
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
                  {showDeleted ? (
                    <div className="flex flex-col items-start gap-1.5">
                      <StatusPill label="Excluída" tone="danger" />
                      {item.deletedAt ? (
                        <span className="text-xs text-zinc-500 dark:text-zinc-400">
                          {formatDateTimeSP(item.deletedAt)}
                        </span>
                      ) : null}
                      <OwnerOnly>
                        <RestoreProductForm
                          productId={item.id}
                          productName={item.name}
                        />
                      </OwnerOnly>
                    </div>
                  ) : itemStatus ? (
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

      <Card id="categorias" title="Categorias">
        <div className="flex flex-col gap-4">
          {categoryRows.length === 0 ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Nenhuma categoria criada ainda. Categorias ajudam a organizar seus
              produtos.
            </p>
          ) : (
            <Table headers={["", "Sala", "Capa na vitrine"]}>
              {categoryRows.map((category) => {
                const coverThumb = category.coverPath
                  ? storage.publicUrl(thumbPathFor(category.coverPath))
                  : null;
                return (
                  <Tr key={category.id}>
                    <Td className="w-14 align-top">
                      {coverThumb ? (
                        <img
                          src={coverThumb}
                          alt=""
                          className="h-12 w-10 rounded-md border border-zinc-200 object-cover dark:border-zinc-700"
                          style={{ objectPosition: `50% ${category.coverFocalY}%` }}
                        />
                      ) : (
                        <span className="flex h-12 w-10 items-center justify-center rounded-md bg-zinc-100 text-sm font-semibold uppercase text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                          {category.name.charAt(0)}
                        </span>
                      )}
                    </Td>
                    <Td className="align-top">
                      <p className="font-medium text-zinc-900 dark:text-zinc-100">
                        {category.name}
                      </p>
                      <p className="text-xs text-zinc-500 dark:text-zinc-400">
                        {category.coverPath ? "Com foto de capa" : "Capa tipográfica"}
                      </p>
                    </Td>
                    <Td className="align-top">
                      <OwnerOnly>
                        <div className="flex flex-col gap-3">
                          <CategoryCoverForm
                            categoryId={category.id}
                            hasCover={Boolean(category.coverPath)}
                            focalY={category.coverFocalY}
                          />
                          {category.coverPath ? (
                            <div className="flex flex-wrap items-start gap-3">
                              <CategoryCoverFocusForm
                                categoryId={category.id}
                                focalY={category.coverFocalY}
                              />
                              <RemoveCategoryCoverForm categoryId={category.id} />
                            </div>
                          ) : null}
                        </div>
                      </OwnerOnly>
                    </Td>
                  </Tr>
                );
              })}
            </Table>
          )}
          <OwnerOnly>
            <CategoryForm />
          </OwnerOnly>
        </div>
      </Card>
    </div>
  );
}
