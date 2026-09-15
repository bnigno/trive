// Etiquetas da peça para imprimir em folha A4 (24 por folha): nome da loja,
// nome da peça, cor/tamanho, SKU e preço ativo. As quantidades vêm pela
// URL (?<idDaVariação>=<n>); sem nada, uma por variação ativa. O form é GET:
// escolher quantidades só recarrega a página, não grava nada.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { PrintButton } from "@/components/admin/print-button";
import { Button, Input } from "@/components/ui/form";
import { Money } from "@/components/ui/money";
import { LABELS_MAX_PER_VARIANT, LABELS_MAX_TOTAL, LABELS_PER_SHEET } from "@/core/catalog/labels";
import { getDb } from "@/db/client";
import { requireUser } from "@/services/auth";
import { getProductLabelSheet } from "@/services/product-labels";

import { LabelSheet, SHEET } from "./label-sheet";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Etiquetas" };

/**
 * No papel só as folhas aparecem, uma por página, sem margem do navegador
 * (a margem já está dentro da folha). Mesmo molde dos cartões da edição: a
 * casca do painel some com display:none e cada folha é um bloco em fluxo.
 */
const PRINT_CSS = `@media print {
  aside, header, nav, .print\\:hidden { display: none !important; }
  main { padding: 0 !important; overflow: visible !important; }
  .label-sheets { display: block !important; overflow: visible !important; padding: 0 !important; background: none !important; border-radius: 0 !important; }
  .label-sheet-wrap { display: block !important; box-shadow: none !important; break-after: page; page-break-after: always; }
  .label, .label-sheet { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  @page { size: A4; margin: 0; }
}`;

const quantityParam = z.string().regex(/^\d{1,6}$/);

/** Só chaves que são id de variação com valor numérico; nenhuma → padrão. */
function parseQuantities(sp: Record<string, string | string[] | undefined>): Record<string, number> | null {
  const quantities: Record<string, number> = {};
  for (const [key, raw] of Object.entries(sp)) {
    if (!z.uuid().safeParse(key).success) continue;
    const value = quantityParam.safeParse(Array.isArray(raw) ? raw[0] : raw);
    if (!value.success) continue;
    quantities[key] = Number(value.data);
  }
  return Object.keys(quantities).length > 0 ? quantities : null;
}

const formatLabelSize = `${String(SHEET.labelWidthMm).replace(".", ",")} × ${String(SHEET.labelHeightMm).replace(".", ",")} mm`;

export default async function ProductLabelsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const quantities = parseQuantities(await searchParams);

  let sheet: Awaited<ReturnType<typeof getProductLabelSheet>>;
  try {
    sheet = await getProductLabelSheet(getDb(), { productId: id, quantities });
  } catch {
    // Produto não encontrado (ou excluído).
    notFound();
  }

  const total = sheet.labels.length;
  const warnings: string[] = [];
  if (sheet.withoutPrice.length > 0) {
    warnings.push(
      sheet.withoutPrice.length === 1
        ? `${sheet.withoutPrice[0]} não tem preço ativo: a etiqueta sai sem preço.`
        : `${sheet.withoutPrice.length} variações não têm preço ativo (${sheet.withoutPrice.join(", ")}): as etiquetas saem sem preço.`,
    );
  }
  if (sheet.truncated) {
    warnings.push(
      `O pedido passou de ${LABELS_MAX_TOTAL} etiquetas (${LABELS_MAX_TOTAL / LABELS_PER_SHEET} folhas) e foi cortado. Imprima em mais de uma vez.`,
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <style>{PRINT_CSS}</style>

      <div className="flex flex-wrap items-start justify-between gap-3 print:hidden">
        <div>
          <Link href={`/admin/produtos/${id}`} className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">
            ← {sheet.productName}
          </Link>
          <h1 className="mt-1 text-xl font-semibold text-zinc-900 dark:text-zinc-100">Etiquetas</h1>
          <p className="max-w-2xl text-sm text-zinc-500 dark:text-zinc-400">
            Folha A4 com {LABELS_PER_SHEET} etiquetas de {formatLabelSize} (Avery L7159 / Pimaco A4356, ou papel
            comum para recortar pelo fio cinza). Imprima em tamanho real — escala 100%, sem “ajustar à página”.
          </p>
        </div>
        {total > 0 ? <PrintButton label="Imprimir etiquetas" /> : null}
      </div>

      {warnings.length > 0 ? (
        <ul className="flex flex-col gap-1 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 print:hidden dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}

      <form method="get" className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white p-4 print:hidden dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Quantas de cada?</h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Até {LABELS_MAX_PER_VARIANT} por variação e {LABELS_MAX_TOTAL} no total.
          </p>
        </div>
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {sheet.lines.map((line) => (
            <li key={line.variantId} className="flex flex-wrap items-center gap-3 py-2">
              <label htmlFor={`qty-${line.variantId}`} className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0 text-sm">
                <span className="font-mono text-xs text-zinc-700 dark:text-zinc-300">{line.sku}</span>
                {line.variantLabel ? <span className="text-zinc-900 dark:text-zinc-100">{line.variantLabel}</span> : null}
                {!line.isActive ? <span className="text-xs text-zinc-500 dark:text-zinc-400">(inativa)</span> : null}
                <span className="text-zinc-500 dark:text-zinc-400">
                  {line.priceCents !== null ? <Money cents={line.priceCents} /> : "Sem preço"}
                </span>
              </label>
              <div className="w-24 shrink-0">
                <Input
                  id={`qty-${line.variantId}`}
                  name={line.variantId}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={LABELS_MAX_PER_VARIANT}
                  defaultValue={line.quantity}
                />
              </div>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit">Atualizar folha</Button>
          <span className="text-sm text-zinc-500 dark:text-zinc-400">
            {total === 0
              ? "Nenhuma etiqueta: escolha as quantidades acima."
              : `${total} ${total === 1 ? "etiqueta" : "etiquetas"} em ${sheet.sheets.length} ${sheet.sheets.length === 1 ? "folha" : "folhas"}.`}
          </span>
        </div>
      </form>

      {total > 0 ? (
        <div className="label-sheets flex flex-col gap-6 overflow-x-auto rounded-lg bg-zinc-100 p-6 dark:bg-zinc-950">
          {sheet.sheets.map((labels, index) => (
            <div key={index} className="label-sheet-wrap w-fit shrink-0 shadow-md">
              <LabelSheet labels={labels} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
