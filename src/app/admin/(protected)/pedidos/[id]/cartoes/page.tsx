// Cartões da edição para imprimir (9 × 12 cm, um por peça do pedido) e a
// carta de estreia (15 × 10): as mesmas imagens que vão na caixa, agora
// arrumadas em folhas A4 de papel fotográfico — 4 cartões por folha (e uma
// folha mista com a carta) para cortar na tesoura, ou 2 por folha com as
// marcas de registro para a Silhouette cortar. Sem imagem ainda, a tela
// lista as peças e o botão desenha; gerar de novo refaz — e a tela avisa
// quando o cartão ficou velho.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { getFileStorage } from "@/adapters/storage";
import { PrintButton } from "@/components/admin/print-button";
import { DxfDownloadButton } from "@/components/print/dxf-download";
import { printCss } from "@/components/print/print-css";
import { Button, Select } from "@/components/ui/form";
import { PAGE_A4 } from "@/core/catalog/silhouette";
import { editionSheetLayout, planEditionSheets, type EditionSheetItemInput } from "@/core/print/edition-sheets";
import { EDITION_CARD, EDITION_LETTER, rectLabelCutDxf } from "@/core/print/round-labels";
import { getDb } from "@/db/client";
import { isOwner, requireUser } from "@/services/auth";
import { getEditionCards, ServiceError } from "@/services/edition-cards";
import { getStoreName } from "@/services/settings";
import { formatDateTimeSP } from "../../format";

import { CardSheet } from "./card-sheet";
import { CardsForm } from "./cards-form";

export const dynamic = "force-dynamic";
/** Até cinco cartões desenhados dentro da action desta página. */
export const maxDuration = 60;

export const metadata: Metadata = { title: "Cartões da edição" };

const formatParam = z.enum(["a4", "silhouette"]).catch("a4");
type SearchParams = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export default async function EditionCardsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  await requireUser();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const format = formatParam.parse(first((await searchParams).formato));
  const db = getDb();
  let cards;
  try {
    cards = await getEditionCards(db, getFileStorage(), id);
  } catch (error) {
    if (error instanceof ServiceError && error.code === "pedido_nao_encontrado") notFound();
    throw error;
  }
  const storeName = await getStoreName(db);
  const owner = await isOwner();
  const generated = cards.at !== null;
  const hasCards = cards.cards.length > 0;
  // Há o que gerar/imprimir: cartões, ou só a carta (primeira compra de uma caneca).
  const hasPieces = hasCards || cards.letter !== null;

  const silhouette = format === "silhouette";
  const mode = silhouette ? "silhouette" : "scissors";
  const letterItem: EditionSheetItemInput | null = cards.letter
    ? { key: "carta", kind: "letter", url: cards.letter.url, alt: `Carta de estreia para ${cards.letter.recipientName}` }
    : null;
  const cardItems: EditionSheetItemInput[] = cards.cards.map((card) => ({ key: card.productId, kind: "card", url: card.url, alt: `Cartão da edição: ${card.name}` }));
  const sheets = planEditionSheets({ letter: letterItem, cards: cardItems, format });
  const printedCards = cardItems.filter((item) => item.url !== null).length;
  const printedLetter = letterItem !== null && letterItem.url !== null;
  const layout = editionSheetLayout(format);
  const cardsPerSheet = layout.cardPositions.length;
  const cardsDxf = silhouette
    ? rectLabelCutDxf({ page: PAGE_A4, positions: layout.cardPositions, widthMm: EDITION_CARD.widthMm, heightMm: EDITION_CARD.heightMm, cornerRadiusMm: EDITION_CARD.cornerRadiusMm })
    : null;
  const letterDxf =
    silhouette && layout.letterPosition
      ? rectLabelCutDxf({ page: PAGE_A4, positions: [layout.letterPosition], widthMm: EDITION_LETTER.widthMm, heightMm: EDITION_LETTER.heightMm, cornerRadiusMm: EDITION_LETTER.cornerRadiusMm })
      : null;

  const warnings: { key: string; text: string }[] = [];
  if (generated && cards.stale) {
    warnings.push({
      key: "stale",
      text: cards.letter?.stale && cards.cards.every((card) => !card.stale)
        ? "A carta de estreia mudou (ou foi escrita) depois da geração — gere de novo antes de imprimir."
        : "O que sai na caixa mudou depois da geração (ficha, nota, nome da edição, presente ou a carta) — gere de novo antes de imprimir.",
    });
  }
  if (generated && (cardItems.some((item) => item.url === null) || (letterItem && letterItem.url === null))) {
    warnings.push({ key: "missing", text: "Há peça (ou a carta) sem imagem ainda: ela fica fora da folha até você gerar de novo." });
  }
  if (cards.isGift && hasCards) {
    warnings.push({
      key: "gift",
      text: "Pedido presente: o QR dos cartões leva à página inicial da loja, não à peça com preço.",
    });
  }
  for (const card of cards.cards) {
    // Presente: o QR nem aponta para a peça, então a página dela não importa.
    if (!cards.isGift && card.publicPage === "agendada" && card.visibleFrom) {
      warnings.push({
        key: `${card.productId}:pagina`,
        text: `A página de “${card.name}” só entra no ar em ${formatDateTimeSP(card.visibleFrom)}: até lá o QR daria página não encontrada.`,
      });
    } else if (!cards.isGift && card.publicPage === "fora_do_ar") {
      warnings.push({
        key: `${card.productId}:pagina`,
        text: `A página de “${card.name}” está fora do ar (peça arquivada, excluída ou rascunho): o QR daria página não encontrada.`,
      });
    }
    if (card.titleTruncated) {
      warnings.push({
        key: `${card.productId}:titulo`,
        text: `O nome “${card.name}” não coube inteiro no título (cabem duas linhas): sai cortado com reticências.`,
      });
    }
    if (card.curatorTruncated) {
      warnings.push({
        key: `${card.productId}:curadora`,
        text: `A frase da curadora de “${card.name}” não coube inteira (cabem umas cinco linhas): sai até o fim da última frase que cabe.`,
      });
    }
    if (card.wearTruncated) {
      warnings.push({
        key: `${card.productId}:veste`,
        text: `O “como veste” de “${card.name}” não coube inteiro (cabem umas três linhas): sai cortado com reticências.`,
      });
    }
    if (card.careTruncated) {
      warnings.push({
        key: `${card.productId}:cuidados`,
        text: `Os cuidados escritos de “${card.name}” não couberam inteiros (cabem umas três linhas): saem cortados.`,
      });
    }
    if (card.careSymbolsDropped > 0) {
      warnings.push({
        key: `${card.productId}:pictogramas`,
        text: `Em “${card.name}”, ${card.careSymbolsDropped === 1 ? "um pictograma de cuidado ficou" : `${card.careSymbolsDropped} pictogramas de cuidado ficaram`} de fora do cartão por falta de espaço.`,
      });
    }
  }
  for (const skip of cards.skipped) {
    warnings.push({ key: `${skip.productId}:sem-cartao`, text: `“${skip.name}” não é peça de roupa: fica sem cartão.` });
  }

  const summary =
    sheets.length === 0
      ? null
      : `${printedCards === 0 ? "" : printedCards === 1 ? "1 cartão" : `${printedCards} cartões`}${printedLetter ? (printedCards > 0 ? " + a carta" : "a carta") : ""} em ${sheets.length === 1 ? "1 folha" : `${sheets.length} folhas`} — ${
          silhouette ? `${cardsPerSheet} cartões por folha (as marcas de registro ocupam as margens; a carta vai sozinha)` : `${cardsPerSheet} cartões por folha (a carta divide a folha com 2 cartões)`
        }.`;

  return (
    <div className="flex flex-col gap-6">
      <style>{printCss("A4")}</style>
      <div className="flex flex-wrap items-start justify-between gap-3 print:hidden">
        <div>
          <Link href={`/admin/pedidos/${id}`} className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">
            ← Pedido #{cards.orderNumber}
          </Link>
          <h1 className="mt-1 text-xl font-semibold text-zinc-900 dark:text-zinc-100">Cartões da edição</h1>
          <p className="max-w-2xl text-sm text-zinc-500 dark:text-zinc-400">
            {cards.letter ? "A carta de estreia (15 × 10 cm) e um cartão por peça (9 × 12 cm)" : "Um cartão por peça, 9 × 12 cm"}
            {silhouette
              ? ", em folha A4 de papel fotográfico já com as marcas de registro do Studio; a Silhouette corta."
              : ", em folha A4 de papel fotográfico; corte pela linha marfim e pelas marcas dos cantos."}
            {generated && cards.at ? ` Gerados em ${formatDateTimeSP(cards.at)}.` : ""}
          </p>
          {cards.isFirstPurchase ? (
            <p className="mt-1 text-sm text-amber-900 dark:text-amber-100">
              Primeira compra desta cliente.
              {cards.letter
                ? ` A carta sai para ${cards.letter.recipientName}.`
                : owner
                  ? ` A carta de estreia ainda não foi escrita — em Configurações › Carta de estreia; depois, ${generated ? "“Gerar de novo”" : "“Gerar cartões”"}.`
                  : " A carta de estreia ainda não foi escrita — peça à dona (fica em Configurações)."}
            </p>
          ) : null}
        </div>
        {hasPieces ? (
          <div className="flex items-center gap-3">
            <CardsForm orderId={id} generated={generated} stale={cards.stale} />
            {sheets.length > 0 ? <PrintButton label={sheets.length === 1 ? "Imprimir 1 folha" : `Imprimir ${sheets.length} folhas`} /> : null}
          </div>
        ) : null}
      </div>

      {warnings.length > 0 ? (
        <ul className="flex flex-col gap-1 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 print:hidden dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          {warnings.map((warning) => (
            <li key={warning.key}>{warning.text}</li>
          ))}
        </ul>
      ) : null}

      {!hasPieces ? (
        <p className="text-sm text-zinc-500 print:hidden dark:text-zinc-400">
          {cards.skipped.length > 0 ? "Este pedido só tem itens que não são roupa: não há cartão." : "Este pedido não tem peças."}
        </p>
      ) : (
        <>
          <form method="get" className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white p-4 print:hidden dark:border-zinc-800 dark:bg-zinc-900">
            <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-zinc-900 dark:text-zinc-100">Impressão</span>
                <Select name="formato" defaultValue={format}>
                  <option value="a4">Papel fotográfico A4 — 4 cartões por folha, corte na tesoura</option>
                  <option value="silhouette">Silhouette Portrait — 2 por folha, imprime aqui com marcas de registro, corta no Studio</option>
                </Select>
              </label>
              <div className="flex items-end">
                <Button type="submit">Atualizar</Button>
              </div>
            </div>
            {summary ? <p className="text-sm text-zinc-500 dark:text-zinc-400">{summary}</p> : null}
          </form>

          {silhouette ? (
            <div className="flex flex-col gap-4 rounded-lg border border-zinc-200 bg-white p-4 text-sm print:hidden dark:border-zinc-800 dark:bg-zinc-900">
              <div>
                <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">Cortar na Silhouette</h2>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  Os {cardsPerSheet} cartões ficam sempre no mesmo lugar da folha (arquivo de corte único); a carta usa o MESMO corte do adesivo da sacola. Papel fotográfico A4 na bandeja de trás, lado brilhante/fosco para cima. Na caixa de diálogo do sistema: tamanho <strong>A4</strong>, escala <strong>100 %</strong>, frente e verso <strong>desmarcado</strong>, qualidade <strong>alta</strong>; tipo de papel <em>Premium Presentation Paper Matte</em> no fotográfico fosco (o recomendado) ou <em>Photo Paper Glossy</em> no brilhante.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {cardsDxf ? <DxfDownloadButton dxf={cardsDxf} fileName="cartoes-corte-silhouette.dxf" label="Baixar corte dos cartões (DXF)" /> : null}
                {letterDxf && cards.letter ? <DxfDownloadButton dxf={letterDxf} fileName="carta-corte-silhouette.dxf" label="Baixar corte da carta (DXF)" /> : null}
              </div>
              <div>
                <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">Primeira vez (uma vez só)</h3>
                <ol className="mt-2 list-decimal space-y-2 pl-5 text-zinc-700 dark:text-zinc-300">
                  <li>
                    Baixe o <strong>corte dos cartões (DXF)</strong>. No <strong>Silhouette Studio</strong>: <em>Preferências</em> → unidades em <strong>mm</strong>; em <em>Importação</em>, DXF <strong>&ldquo;As Is&rdquo;</strong>.
                  </li>
                  <li>
                    Abra o DXF. <em>Configuração de página</em>: tamanho <strong>A4</strong>, base de corte <em>Portrait</em>; <strong>marcas de registro ligadas</strong>, em <em>Restaurar padrões</em>. Selecione tudo, confira <strong>210 × 297 mm</strong> no <em>Transformar</em>, ponto de referência no canto superior esquerdo → <strong>X 0, Y 0</strong> → apague o retângulo grande (camada PAGINA). Os dois retângulos devem cair na área sem hachura, com a mesma folga em cima e embaixo.
                  </li>
                  <li>
                    <em>Salvar como</em> <strong>&ldquo;TRIVÉ cartões.studio3&rdquo;</strong>. A carta não precisa de arquivo novo: é o <strong>&ldquo;TRIVÉ sacola.studio3&rdquo;</strong> do adesivo (se ainda não existir, o DXF da carta está acima e o passo é o mesmo).
                  </li>
                </ol>
              </div>
              <div>
                <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">Cada vez</h3>
                <ol className="mt-2 list-decimal space-y-2 pl-5 text-zinc-700 dark:text-zinc-300">
                  <li>Folha impressa na <strong>base de corte (mat)</strong>, marcas para cima e o quadrado no canto da seta, cobrindo a linha preta da grade.</li>
                  <li>
                    Folha de cartões: abra <strong>&ldquo;TRIVÉ cartões.studio3&rdquo;</strong>. Folha da carta: abra <strong>&ldquo;TRIVÉ sacola.studio3&rdquo;</strong>. Em <em>Enviar</em>, material <strong>Cartolina lisa</strong> (<em>Cardstock, plain</em>) ou <em>Photo Paper</em>, AutoBlade — é um <strong>corte total</strong> (atravessa o papel), não o &ldquo;kiss cut&rdquo; do adesivo. Comece numa folha comum e suba a força até atravessar o fotográfico sem rasgar.
                  </li>
                </ol>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2 rounded-lg border border-zinc-200 bg-white p-4 text-sm print:hidden dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">Como imprimir</h2>
              <ol className="list-decimal space-y-2 pl-5 text-zinc-700 dark:text-zinc-300">
                <li>
                  Papel fotográfico A4 (fosco fica mais elegante e não marca dedo) na bandeja de trás, lado de impressão para cima. Na caixa de diálogo do sistema: tamanho <strong>A4</strong>, escala <strong>100 %</strong>, frente e verso desmarcado, qualidade <strong>alta</strong>; tipo de papel <em>Premium Presentation Paper Matte</em> no fosco ou <em>Photo Paper Glossy</em> no brilhante.
                </li>
                <li>
                  Corte pela <strong>linha marfim</strong> do cartão e pelas <strong>marcas dos cantos</strong>, com régua e estilete (ou guilhotina). O marfim vai 1 mm além do corte: cortar um pouco fora não deixa borda branca. A carta não tem linha — valem as marcas.
                </li>
                <li>
                  Quer o corte perfeito, com cantos arredondados, sem régua? Troque para <strong>Silhouette Portrait</strong> acima.
                </li>
              </ol>
            </div>
          )}

          {sheets.length > 0 ? (
            <div className="print-area flex flex-col gap-6 overflow-x-auto rounded-lg bg-zinc-100 p-6 dark:bg-zinc-950">
              {sheets.map((sheet, index) => (
                <CardSheet key={index} sheet={sheet} mode={mode} index={index + 1} total={sheets.length} storeName={storeName} orderNumber={cards.orderNumber} />
              ))}
            </div>
          ) : null}

          <ul className="flex flex-col gap-1 text-xs text-zinc-500 print:hidden dark:text-zinc-400">
            {cards.letter ? (
              <li>
                Carta de estreia · para {cards.letter.recipientName}
                {cards.letter.url === null ? " · sem imagem — toque em “Gerar cartões”" : cards.letter.stale ? " · ficou velha — gere de novo" : ""}
              </li>
            ) : null}
            {cards.cards.map((card) => (
              <li key={card.productId}>
                {card.name}
                {card.url === null ? ` · sem imagem — toque em ${generated ? "“Gerar de novo”" : "“Gerar cartões”"}` : card.stale ? " · ficou velho — gere de novo" : ""}
                {card.hasCuratorNote ? null : (
                  <>
                    {" · sem frase da curadora"}
                    {owner ? (
                      <>
                        {" ("}
                        <Link href={`/admin/produtos/${card.productId}`} className="underline">
                          grave a nota na tela da peça
                        </Link>
                        {generated ? " e gere de novo)" : " e gere os cartões)"}
                      </>
                    ) : (
                      " (peça à dona para gravar a nota antes de imprimir)"
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
