// Etiquetas da peça para imprimir. Dois modelos: a TAG DE CABIDE (cartão de
// 55 × 90 mm com a marca na frente e nome, cor/tamanho, referência e QR da
// peça atrás — sem preço) e a ADESIVA (Pimaco A4355, 27 por folha, com preço). A tag
// sai em folha A4 frente e verso (3 × 3 para cortar na tesoura, ou 2 × 2 com
// as marcas de registro para a Silhouette cortar) ou no arquivo de gráfica
// (uma página por lado). As quantidades vêm pela URL (?<idDaVariação>=<n>);
// sem nada, uma por variação ativa. O form é GET: escolher só recarrega, não
// grava nada.
import { Fragment } from "react";
import type { Metadata } from "next";
import { Cormorant_Garamond, Jost } from "next/font/google";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { PrintButton } from "@/components/admin/print-button";
import { PrintSideButtons } from "@/components/admin/print-side-buttons";
import { Button, Input, Select } from "@/components/ui/form";
import { Money } from "@/components/ui/money";
import { LABELS_MAX_PER_VARIANT, LABELS_MAX_SHEETS, LABELS_PER_SHEET, labelsMaxTotal, labelsPerSheet, type LabelModel } from "@/core/catalog/labels";
import { hangTagCutDxf, PAGE_A4, silhouetteTagPositions } from "@/core/catalog/silhouette";
import { getDb } from "@/db/client";
import { qrSvgPath, qrVersion } from "@/receipts/qr";
import { requireUser } from "@/services/auth";
import { getProductLabelSheet } from "@/services/product-labels";

import { HangTagDefs, TAG } from "./hang-tag";
import { HangTagPress, PRESS_PAGE } from "./hang-tag-press";
import { HangTagSheets } from "./hang-tag-sheets";
import { LabelSheet, SHEET } from "./label-sheet";
import { SilhouetteSheet } from "./hang-tag-silhouette";
import { SilhouetteDownloads } from "./silhouette-downloads";
import { printCss } from "@/components/print/print-css";

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
const formatParam = z.enum(["a4", "grafica", "silhouette"]).catch("a4");

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
  const maxTotal = labelsMaxTotal(model, format);
  const silhouette = model === "cabide" && format === "silhouette";
  const pages = model === "adesiva" ? sheet.sheets.length : format === "grafica" ? sheet.designs.length * 2 : sheet.sheets.length * 2;
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

  const printLabel = model === "adesiva" ? "Imprimir etiquetas" : "Salvar PDF para a gráfica";
  // Folhas frente e verso em casa: botões por lado (a impressora não vira papel grosso sozinha).
  const printBySide = model === "cabide" && (format === "a4" || silhouette);
  const cutTag = { widthMm: TAG.widthMm, heightMm: TAG.heightMm, holeCenterXMm: TAG.widthMm / 2, holeCenterYMm: TAG.holeCenterYMm };
  // O mesmo DXF para toda folha: as posições são fixas; numa folha com menos tags a plotter corta papel em branco, sem prejuízo.
  const cutDxf = silhouette ? hangTagCutDxf({ page: PAGE_A4, positions: silhouetteTagPositions({ widthMm: TAG.widthMm, heightMm: TAG.heightMm }, PAGE_A4), tag: cutTag }) : null;
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
          <h1 className="mt-1 text-xl font-semibold text-zinc-900 dark:text-zinc-100">
            Etiquetas{" "}
            <Link href="/admin/produtos/selos" className="ml-2 align-middle text-sm font-normal text-indigo-600 hover:underline dark:text-indigo-400">
              Selos de embalagem →
            </Link>
          </h1>
          <p className="max-w-2xl text-sm text-zinc-500 dark:text-zinc-400">
            {model === "adesiva"
              ? `Folha A4 com ${LABELS_PER_SHEET.adesiva} etiquetas de ${formatLabelSize} (Pimaco A4355). Imprima em tamanho real — escala 100%, sem "ajustar à página"; o fio cinza é guia só na tela, não sai no papel.`
              : format === "a4"
                ? `Folha A4 com ${LABELS_PER_SHEET.cabide} tags de ${mm(TAG.widthMm)} × ${mm(TAG.heightMm)}, frente e verso. Papel cartão creme de 180–300 g, escala 100%. Impressora de casa não vira papel grosso sozinha: imprima todas as frentes, vire a pilha inteira como quem fecha um livro e imprima os versos — primeiro uma folha de teste, para conferir contra a luz se frente e verso batem. Corte pelas marcas dos cantos e fure na cruz do topo (furador de 4 a 6 mm ou ilhós).`
                : format === "silhouette"
                  ? `Silhouette Portrait: folha A4 com ${labelsPerSheet("cabide", "silhouette")} tags de ${mm(TAG.widthMm)} × ${mm(TAG.heightMm)}, impressa aqui já com as marcas de registro que a plotter lê. No Studio só se abre o arquivo de corte (uma vez) e manda cortar o contorno arredondado e o furo. Passo a passo abaixo.`
                  : `Arquivo para gráfica: uma página por lado, ${mm(PRESS_PAGE.widthMm)} × ${mm(PRESS_PAGE.heightMm)} (tag de ${mm(TAG.widthMm)} × ${mm(TAG.heightMm)} com ${mm(TAG.bleedMm)} de sangria e marcas de corte). Nada sangra: a gráfica escolhe o papel. Salve como PDF pelo Chrome (o Safari ignora o tamanho da página) e mande junto a lista de quantidades abaixo.`}
          </p>
        </div>
        {total > 0 ? printBySide ? <PrintSideButtons sheets={sheet.sheets.length} /> : <PrintButton label={printLabel} /> : null}
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
              <option value="adesiva">Etiqueta adesiva — SKU e preço (Pimaco A4355, 27 por folha)</option>
            </Select>
          </label>
          {model === "cabide" ? (
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-zinc-900 dark:text-zinc-100">Impressão</span>
              <Select name="formato" defaultValue={format}>
                <option value="a4">Impressora comum — folha A4 frente e verso</option>
                <option value="silhouette">Silhouette Portrait — imprime aqui com marcas de registro, corta no Studio (4 por folha)</option>
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

      {printBySide && total > 0 ? (
        <div className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white p-4 text-sm print:hidden dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">Como imprimir frente e verso em casa</h2>
          <ol className="list-decimal space-y-2 pl-5 text-zinc-700 dark:text-zinc-300">
            <li>
              {silhouette
                ? "Papel: o melhor é fotográfico FOSCO DUPLA FACE A4 (220 g) — o verso imprime bem e o sensor da plotter não sofre com reflexo. No glossy de uma face só, o verso sai no dorso sem revestimento: imprima o verso como papel comum. Folhas na bandeja de trás com o lado de imprimir para cima. "
                : "Papel cartão A4 na bandeja de trás, lado da frente para cima. "}
              Clique em <strong>Imprimir frentes</strong>.
              {silhouette ? (
                <>
                  {" "}
                  Na prévia do Chrome, clique em <em>Imprimir usando a caixa de diálogo do sistema…</em> (o link no rodapé da prévia — não use o atalho de teclado direto nesta página, senão saem os dois lados). Na janela do sistema confira <strong>tamanho A4</strong>, <strong>escala 100 %</strong> e <strong>Frente e verso desmarcado</strong>; no painel da Epson (em <em>Opções da Impressora</em>, onde ficam tipo de papel e qualidade): tipo <strong>Premium Presentation Paper Matte</strong> no fosco — ou <strong>Photo Paper Glossy</strong> no glossy — e qualidade <strong>normal ou alta</strong> (no rascunho as marcas saem claras e a plotter não lê). Salve como predefinição &ldquo;TRIVÉ tags&rdquo; para as próximas vezes.
                </>
              ) : (
                <>
                  {" "}
                  No diálogo: tamanho <strong>A4</strong>, escala <strong>100 %</strong>, margens padrão (a página já é sem margem), frente e verso <strong>desligado</strong> — se abrir a caixa de diálogo do sistema, confira isso lá também.
                </>
              )}
            </li>
            <li>
              Pegue a pilha como saiu e <strong>vire o bloco inteiro de uma vez, como quem fecha um livro</strong> (pela lateral) — não folha por folha e não de cabeça para baixo. De volta na bandeja de trás, lado em branco para cima e o <strong>topo da folha entrando primeiro</strong>: a borda com o rodapé &ldquo;folha n de N&rdquo; é a que fica para fora da bandeja (o texto fica virado para o apoio de papel — de frente você vê só o lado em branco).
            </li>
            <li>
              Clique em <strong>Imprimir versos</strong>, com as mesmas opções{silhouette ? " (a mesma predefinição; no glossy de uma face, tipo de papel comum)" : ""}. Conferência: em cada folha, &ldquo;folha 2 · frente&rdquo; e &ldquo;folha 2 · verso&rdquo; na mesma folha <strong>e na mesma borda</strong> — se saíram em bordas opostas, a pilha entrou girada.
            </li>
          </ol>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Impressora de casa só vira papel comum (64–90 g) sozinha: &ldquo;frente e verso numa passada&rdquo; serve para uma folha de teste em papel comum (frente e verso na <em>borda longa</em>), não para o papel da tag.
          </p>
        </div>
      ) : null}

      {silhouette && total > 0 && cutDxf ? (
        <div className="flex flex-col gap-4 rounded-lg border border-zinc-200 bg-white p-4 text-sm print:hidden dark:border-zinc-800 dark:bg-zinc-900">
          <div>
            <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">Cortar na Silhouette</h2>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              O arquivo de corte é o mesmo para toda folha e toda peça: as 4 molduras ficam sempre no mesmo lugar. Numa folha com menos tags, a plotter corta o resto em branco — sem prejuízo.
            </p>
          </div>
          <SilhouetteDownloads dxf={cutDxf} />
          <div>
            <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">Primeira vez (uma vez só, uns 3 minutos)</h3>
            <ol className="mt-2 list-decimal space-y-2 pl-5 text-zinc-700 dark:text-zinc-300">
              <li>
                Baixe o <strong>arquivo de corte (DXF)</strong> acima. No <strong>Silhouette Studio</strong> (Basic serve): <em>Preferências</em> → unidades em <strong>mm</strong>; em <em>Importação</em>, DXF <strong>&ldquo;As Is&rdquo;</strong> (não &ldquo;Fit to Page&rdquo;).
              </li>
              <li>
                Abra o DXF. <em>Configuração de página</em>: tamanho <strong>A4</strong>, base de corte <em>Portrait</em>; <strong>marcas de registro ligadas</strong> (Tipo 1), clique em <em>Restaurar padrões</em> e confira os valores: recuos <strong>15,9 mm</strong> (esquerda, cima, direita) e <strong>26 mm</strong> (embaixo), comprimento <strong>20 mm</strong>, espessura <strong>0,5 mm</strong> — não mova as marcas. Selecione tudo e confira no painel <em>Transformar</em> que a seleção mede <strong>210 × 297 mm</strong> (o retângulo grande é a folha; se vier em outro tamanho, digite 210 com a proporção travada); ponto de referência no canto <strong>superior esquerdo</strong> → <strong>X 0, Y 0</strong> → apague o retângulo grande (camada PAGINA). As 4 molduras devem cair na área sem hachura, as marcas da tela devem coincidir com as impressas na folha e o <strong>furo de cada moldura fica perto do topo</strong> (8 mm da borda de cima) — se estiver embaixo, o DXF entrou invertido: espelhe na vertical.
              </li>
              <li>
                <em>Salvar como</em> <strong>&ldquo;TRIVÉ tags.studio3&rdquo;</strong>. Pronto: esse arquivo vale para sempre.
              </li>
            </ol>
          </div>
          <div>
            <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">Cada vez</h3>
            <ol className="mt-2 list-decimal space-y-2 pl-5 text-zinc-700 dark:text-zinc-300">
              <li>
                Folha impressa na base de corte, <strong>frente (com as marcas) para cima</strong>, o quadrado no canto que a seta da base indica, cobrindo a linha preta da grade.
              </li>
              <li>
                Abra <strong>&ldquo;TRIVÉ tags.studio3&rdquo;</strong> (Recentes) → <em>Enviar</em> → material <em>Cardstock</em> ou <em>Photo Paper</em>, AutoBlade → cortar. A plotter lê as marcas e corta contorno e furo das 4 tags. Na primeira vez, um teste em <strong>papel comum</strong>: imprima frente e verso de uma folha, confira contra a luz se as tags do verso caem sobre as da frente (e os rodapés na mesma borda), depois corte com pressão baixa — só então o papel fotográfico.
              </li>
            </ol>
          </div>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            <strong>&ldquo;Não leu as marcas&rdquo;</strong>: luz forte por cima da máquina em vez de lateral; papel glossy reflete no sensor — cole um adesivo branco fosco nos cantos das marcas antes de imprimir, ou use o fotográfico <strong>fosco dupla face</strong>; marcas claras → qualidade normal ou alta; se insistir, <em>registro manual</em> no Studio.
          </p>
        </div>
      ) : null}

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
              {silhouette ? (
                sheet.sheets.map((labels, index) => (
                  <Fragment key={index}>
                    <SilhouetteSheet labels={labels} side="front" storeName={sheet.storeName} productName={sheet.productName} index={index + 1} total={sheet.sheets.length} />
                    <SilhouetteSheet labels={labels} side="back" storeName={sheet.storeName} productName={sheet.productName} index={index + 1} total={sheet.sheets.length} />
                  </Fragment>
                ))
              ) : format === "a4" ? (
                <HangTagSheets sheets={sheet.sheets} storeName={sheet.storeName} productName={sheet.productName} />
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
