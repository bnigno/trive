// Etiquetas da peça para imprimir. Dois modelos: a TAG DE CABIDE (cartão de
// 55 × 90 mm com a marca na frente e nome, cor/tamanho, referência e QR da
// peça atrás — sem preço) e a ADESIVA (Avery 24 por folha, com preço). A tag
// sai em folha A4 frente e verso ou no arquivo de gráfica (uma página por
// lado). As quantidades vêm pela URL (?<idDaVariação>=<n>); sem nada, uma
// por variação ativa. O form é GET: escolher só recarrega, não grava nada.
import type { Metadata } from "next";
import { Cormorant_Garamond, Jost } from "next/font/google";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { PrintButton } from "@/components/admin/print-button";
import { Button, Input, Select } from "@/components/ui/form";
import { Money } from "@/components/ui/money";
import { LABELS_MAX_PER_VARIANT, LABELS_MAX_SHEETS, LABELS_PER_SHEET, labelsMaxTotal, type LabelModel } from "@/core/catalog/labels";
import { getDb } from "@/db/client";
import { qrSvgPath, qrVersion } from "@/receipts/qr";
import { requireUser } from "@/services/auth";
import { getProductLabelSheet } from "@/services/product-labels";

import { HangTagDefs, TAG } from "./hang-tag";
import { HangTagPress, PRESS_PAGE } from "./hang-tag-press";
import { HangTagSheets } from "./hang-tag-sheets";
import { LabelSheet, SHEET } from "./label-sheet";
import { printCss } from "./print-css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Etiquetas" };

// As fontes da marca (as mesmas da vitrine): o painel usa Geist, a tag não.
const cormorant = Cormorant_Garamond({
  variable: "--font-cormorant",
  subsets: ["latin", "latin-ext"],
  weight: ["400", "600"],
  style: ["normal", "italic"],
  display: "swap",
  preload: false,
});
const jost = Jost({
  variable: "--font-jost",
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500"],
  display: "swap",
  preload: false,
});

const quantityParam = z.string().regex(/^\d{1,6}$/);
const modelParam = z.enum(["cabide", "adesiva"]).catch("cabide");
const formatParam = z.enum(["a4", "grafica"]).catch("a4");

type SearchParams = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/** Só chaves que são id de variação com valor numérico; nenhuma → padrão. */
function parseQuantities(sp: SearchParams): Record<string, number> | null {
  const quantities: Record<string, number> = {};
  for (const [key, raw] of Object.entries(sp)) {
    if (!z.uuid().safeParse(key).success) continue;
    const value = quantityParam.safeParse(first(raw));
    if (!value.success) continue;
    quantities[key] = Number(value.data);
  }
  return Object.keys(quantities).length > 0 ? quantities : null;
}

const mm = (value: number) => `${String(value).replace(".", ",")} mm`;
const formatLabelSize = `${String(SHEET.labelWidthMm).replace(".", ",")} × ${String(SHEET.labelHeightMm).replace(".", ",")} mm`;

export default async function ProductLabelsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  await requireUser();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const sp = await searchParams;
  const quantities = parseQuantities(sp);
  const model: LabelModel = modelParam.parse(first(sp.modelo));
  const format = model === "cabide" ? formatParam.parse(first(sp.formato)) : "a4";

  let sheet: Awaited<ReturnType<typeof getProductLabelSheet>>;
  try {
    sheet = await getProductLabelSheet(getDb(), { productId: id, model, format, quantities });
  } catch {
    // Produto não encontrado (ou excluído).
    notFound();
  }

  const total = sheet.labels.length;
  const maxTotal = labelsMaxTotal(model);
  const pages = model === "adesiva" ? sheet.sheets.length : format === "a4" ? sheet.sheets.length * 2 : sheet.designs.length * 2;
  const warnings: string[] = [];
  if (model === "adesiva" && sheet.withoutPrice.length > 0) {
    warnings.push(
      sheet.withoutPrice.length === 1
        ? `${sheet.withoutPrice[0]} não tem preço ativo: a etiqueta sai sem preço.`
        : `${sheet.withoutPrice.length} variações não têm preço ativo (${sheet.withoutPrice.join(", ")}): as etiquetas saem sem preço.`,
    );
  }
  if (sheet.truncated) {
    warnings.push(`O pedido passou de ${maxTotal} etiquetas (${LABELS_MAX_SHEETS} folhas) e foi cortado. Imprima em mais de uma vez.`);
  }
  if (model === "cabide" && sheet.productStatus !== "active") {
    warnings.push(
      sheet.productStatus === "archived"
        ? "A peça está arquivada: o QR da tag leva a uma página que não existe mais."
        : "A peça ainda está em rascunho: o QR da tag só vai funcionar depois de publicar.",
    );
  }
  if (model === "cabide" && qrVersion(sheet.productUrl) > 7) {
    warnings.push("O endereço da peça é longo e o QR fica denso demais para 20 mm: encurte o nome (identificador) da peça antes de imprimir.");
  }

  const printLabel = model === "adesiva" ? "Imprimir etiquetas" : format === "a4" ? "Imprimir tags" : "Salvar PDF para a gráfica";
  const summary =
    total === 0
      ? "Nenhuma etiqueta: escolha as quantidades acima."
      : model === "cabide" && format === "grafica"
        ? `${sheet.designs.length} ${sheet.designs.length === 1 ? "modelo" : "modelos"} → ${pages} páginas (frente e verso), ${total} ${total === 1 ? "tag" : "tags"} no total.`
        : `${total} ${total === 1 ? "etiqueta" : "etiquetas"} em ${sheet.sheets.length} ${sheet.sheets.length === 1 ? "folha" : "folhas"}${model === "cabide" ? ` (${pages} páginas, frente e verso)` : ""}.`;

  return (
    <div className="flex flex-col gap-6">
      <style>{printCss(model === "cabide" && format === "grafica" ? "61mm 96mm" : "A4")}</style>

      <div className="flex flex-wrap items-start justify-between gap-3 print:hidden">
        <div>
          <Link href={`/admin/produtos/${id}`} className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">
            ← {sheet.productName}
          </Link>
          <h1 className="mt-1 text-xl font-semibold text-zinc-900 dark:text-zinc-100">Etiquetas</h1>
          <p className="max-w-2xl text-sm text-zinc-500 dark:text-zinc-400">
            {model === "adesiva"
              ? `Folha A4 com ${LABELS_PER_SHEET.adesiva} etiquetas de ${formatLabelSize} (Avery L7159 / Pimaco A4356, ou papel comum para recortar pelo fio cinza). Imprima em tamanho real — escala 100%, sem "ajustar à página".`
              : format === "a4"
                ? `Folha A4 com ${LABELS_PER_SHEET.cabide} tags de ${mm(TAG.widthMm)} × ${mm(TAG.heightMm)}, frente e verso. Papel cartão creme de 180–300 g. Imprima em frente e verso virando na borda longa, escala 100% — primeiro uma folha de teste, para conferir contra a luz se frente e verso batem. Corte pelas marcas dos cantos e fure na cruz do topo (furador de 4 a 6 mm ou ilhós).`
                : `Arquivo para gráfica: uma página por lado, ${mm(PRESS_PAGE.widthMm)} × ${mm(PRESS_PAGE.heightMm)} (tag de ${mm(TAG.widthMm)} × ${mm(TAG.heightMm)} com ${mm(TAG.bleedMm)} de sangria e marcas de corte). Nada sangra: a gráfica escolhe o papel. Salve como PDF pelo Chrome (o Safari ignora o tamanho da página) e mande junto a lista de quantidades abaixo.`}
          </p>
        </div>
        {total > 0 ? <PrintButton label={printLabel} /> : null}
      </div>

      {warnings.length > 0 ? (
        <ul className="flex flex-col gap-1 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 print:hidden dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}

      <form method="get" className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white p-4 print:hidden dark:border-zinc-800 dark:bg-zinc-900">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-zinc-900 dark:text-zinc-100">Modelo</span>
            <Select name="modelo" defaultValue={model}>
              <option value="cabide">Tag de cabide — marca na frente, peça e QR atrás</option>
              <option value="adesiva">Etiqueta adesiva — SKU e preço (Avery, 24 por folha)</option>
            </Select>
          </label>
          {model === "cabide" ? (
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-zinc-900 dark:text-zinc-100">Impressão</span>
              <Select name="formato" defaultValue={format}>
                <option value="a4">Impressora comum — folha A4 frente e verso</option>
                <option value="grafica">Gráfica — PDF, uma tag por página</option>
              </Select>
            </label>
          ) : null}
        </div>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Quantas de cada?</h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {model === "cabide" && format === "grafica"
              ? `Até ${LABELS_MAX_PER_VARIANT} por variação (a gráfica imprime a quantidade).`
              : `Até ${LABELS_MAX_PER_VARIANT} por variação e ${maxTotal} no total.`}
          </p>
        </div>
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {sheet.lines.map((line) => (
            <li key={line.variantId} className="flex flex-wrap items-center gap-3 py-2">
              <label htmlFor={`qty-${line.variantId}`} className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0 text-sm">
                <span className="font-mono text-xs text-zinc-700 dark:text-zinc-300">{line.sku}</span>
                {line.variantLabel ? <span className="text-zinc-900 dark:text-zinc-100">{line.variantLabel}</span> : null}
                {!line.isActive ? <span className="text-xs text-zinc-500 dark:text-zinc-400">(inativa)</span> : null}
                {model === "adesiva" ? (
                  <span className="text-zinc-500 dark:text-zinc-400">
                    {line.priceCents !== null ? <Money cents={line.priceCents} /> : "Sem preço"}
                  </span>
                ) : null}
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
          <Button type="submit">Atualizar</Button>
          <span className="text-sm text-zinc-500 dark:text-zinc-400">{summary}</span>
        </div>
      </form>

      {model === "cabide" && format === "grafica" && sheet.designs.length > 0 ? (
        <div className="rounded-lg border border-zinc-200 bg-white p-4 text-sm print:hidden dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">Para a gráfica</h2>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            Cada modelo ocupa duas páginas do PDF (frente e verso). Mande esta lista com o arquivo:
          </p>
          <ul className="mt-2 divide-y divide-zinc-100 font-mono text-xs dark:divide-zinc-800">
            {sheet.designs.map((design, index) => (
              <li key={design.key} className="flex flex-wrap justify-between gap-2 py-1">
                <span>
                  páginas {index * 2 + 1}–{index * 2 + 2} → {design.sku}
                  {design.variantLabel ? ` (${design.variantLabel})` : ""}
                </span>
                <span>{design.quantity} un.</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {total > 0 ? (
        <div
          data-store=""
          className={`print-area flex flex-col gap-6 overflow-x-auto rounded-lg bg-zinc-100 p-6 dark:bg-zinc-950 ${cormorant.variable} ${jost.variable}`}
        >
          {model === "adesiva" ? (
            sheet.sheets.map((labels, index) => (
              <div key={index} className="print-page w-fit shrink-0 shadow-md">
                <LabelSheet labels={labels} />
              </div>
            ))
          ) : (
            <>
              <HangTagDefs qr={qrSvgPath(sheet.productUrl)} />
              {format === "a4" ? (
                <HangTagSheets sheets={sheet.sheets} storeName={sheet.storeName} />
              ) : (
                <HangTagPress designs={sheet.designs} storeName={sheet.storeName} />
              )}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
