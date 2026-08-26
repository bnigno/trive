import type { Metadata } from "next";
import Link from "next/link";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { EmptyState } from "@/components/ui/empty-state";
import { Button, Field, FormError, Input, Select } from "@/components/ui/form";
import { Money } from "@/components/ui/money";
import { PageHeader } from "@/components/ui/page-header";
import { getDb } from "@/db/client";
import { products, productVariants } from "@/db/schema";
import { requireOwner } from "@/services/auth";
import {
  getPricingContext,
  ServiceError,
  type PricingContext,
} from "@/services/pricing";
import {
  centsToInputBRL,
  formatPercent,
  rateToInputPercent,
} from "../labels";
import { ApplyPriceToProduct } from "./apply-to-product";
import { CalculatorForm } from "./calculator-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Calculadora de preços" };

const linkButtonClasses =
  "inline-flex items-center justify-center rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800";

async function listActiveVariants(query: string) {
  const db = getDb();
  const rows = await db
    .select({
      id: productVariants.id,
      sku: productVariants.sku,
      productName: products.name,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(
      and(eq(productVariants.isActive, true), isNull(productVariants.deletedAt)),
    )
    .orderBy(productVariants.sku);

  const needle = query.toLowerCase();
  return needle
    ? rows.filter(
        (row) =>
          row.sku.toLowerCase().includes(needle) ||
          row.productName.toLowerCase().includes(needle),
      )
    : rows;
}

async function countActiveVariants(productId: string): Promise<number> {
  const rows = await getDb()
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.productId, productId),
        eq(productVariants.isActive, true),
        isNull(productVariants.deletedAt),
      ),
    );
  return rows.length;
}

function VariantPicker({
  variants,
  query,
}: {
  variants: { id: string; sku: string; productName: string }[];
  query: string;
}) {
  return (
    <div className="flex max-w-xl flex-col gap-4 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <form method="get" className="flex items-end gap-2">
        <Field label="Buscar variante" className="flex-1">
          <Input
            type="search"
            name="busca"
            defaultValue={query}
            placeholder="SKU ou nome do produto…"
          />
        </Field>
        <Button type="submit" variant="outline">
          Filtrar
        </Button>
      </form>

      {variants.length === 0 ? (
        <EmptyState
          title={
            query
              ? `Nenhuma variante encontrada para “${query}”.`
              : "Nenhuma variante ativa por aqui."
          }
          hint={
            query
              ? "Tente outra parte do SKU ou do nome."
              : "Cadastre um produto para começar a precificar."
          }
          action={
            query ? (
              <Link href="/admin/precos/calculadora" className={linkButtonClasses}>
                Limpar busca
              </Link>
            ) : (
              <Link href="/admin/produtos/novo" className={linkButtonClasses}>
                Cadastrar produto
              </Link>
            )
          }
        />
      ) : (
        <form method="get" className="flex items-end gap-2">
          <Field label="Escolha o SKU" className="flex-1">
            <Select name="variant" defaultValue={variants[0].id}>
              {variants.map((variant) => (
                <option key={variant.id} value={variant.id}>
                  {variant.sku} — {variant.productName}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit">Abrir calculadora</Button>
        </form>
      )}
    </div>
  );
}

export default async function CalculatorPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireOwner("precos");
  const sp = await searchParams;
  const variantParam = (
    typeof sp.variant === "string" ? sp.variant : ""
  ).trim();
  const query = (typeof sp.busca === "string" ? sp.busca : "").trim();

  if (!variantParam) {
    const variants = await listActiveVariants(query);
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Calculadora de preços"
          subtitle="Escolha uma variante para ver a conta do preço, linha a linha."
          actions={
            <Link href="/admin/precos" className={linkButtonClasses}>
              Voltar para preços
            </Link>
          }
        />
        <VariantPicker variants={variants} query={query} />
      </div>
    );
  }

  const parsedId = z.uuid().safeParse(variantParam);
  const db = getDb();
  const variantRow = parsedId.success
    ? (
        await db
          .select({
            sku: productVariants.sku,
            productName: products.name,
          })
          .from(productVariants)
          .innerJoin(products, eq(products.id, productVariants.productId))
          .where(eq(productVariants.id, parsedId.data))
          .limit(1)
      )[0]
    : undefined;

  if (!parsedId.success || !variantRow) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Calculadora de preços" />
        <EmptyState
          title="Variante não encontrada."
          hint="O link pode estar desatualizado. Escolha a variante de novo."
          action={
            <Link href="/admin/precos/calculadora" className={linkButtonClasses}>
              Escolher variante
            </Link>
          }
        />
      </div>
    );
  }

  let context: PricingContext | null = null;
  let contextError: string | null = null;
  try {
    context = await getPricingContext(db, parsedId.data);
  } catch (error) {
    contextError =
      error instanceof ServiceError
        ? error.message
        : "Algo deu errado, tente novamente.";
  }

  const siblingCount = context
    ? await countActiveVariants(context.variant.productId)
    : 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Calculadora de preços"
        subtitle={`${variantRow.sku} — ${variantRow.productName}`}
        actions={
          <>
            <Link href="/admin/precos/calculadora" className={linkButtonClasses}>
              Trocar SKU
            </Link>
            <Link
              href={`/admin/precos/historico/${parsedId.data}`}
              className={linkButtonClasses}
            >
              Ver histórico
            </Link>
          </>
        }
      />

      {context === null ? (
        <div className="max-w-2xl">
          <FormError message={contextError} />
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-x-8 gap-y-2 rounded-lg border border-zinc-200 bg-white px-5 py-4 text-sm dark:border-zinc-800 dark:bg-zinc-900">
            <p className="text-zinc-600 dark:text-zinc-400">
              Custo atual:{" "}
              <Money
                cents={context.variant.costCents}
                className="font-medium text-zinc-900 dark:text-zinc-100"
              />
            </p>
            <p className="text-zinc-600 dark:text-zinc-400">
              Preço ativo:{" "}
              {context.previousActive ? (
                <Money
                  cents={context.previousActive.priceCents}
                  className="font-medium text-zinc-900 dark:text-zinc-100"
                />
              ) : (
                <span className="font-medium text-zinc-900 dark:text-zinc-100">
                  ainda sem preço
                </span>
              )}
            </p>
            <p className="text-zinc-600 dark:text-zinc-400">
              Margem mínima da política:{" "}
              <span className="font-medium text-zinc-900 dark:text-zinc-100">
                {formatPercent(context.policy.minMarginRate)}
              </span>
            </p>
          </div>

          <CalculatorForm
            variantId={parsedId.data}
            defaults={{
              margem: rateToInputPercent(context.policy.targetMarginRate),
              custosFixos: centsToInputBRL(context.policy.otherCostsFixedCents),
              arredondamento: context.policy.roundingMode,
            }}
          />

          {siblingCount > 1 ? (
            <ApplyPriceToProduct
              productId={context.variant.productId}
              variantCount={siblingCount}
              defaultPrice={
                context.previousActive
                  ? centsToInputBRL(context.previousActive.priceCents)
                  : ""
              }
            />
          ) : null}
        </>
      )}
    </div>
  );
}
