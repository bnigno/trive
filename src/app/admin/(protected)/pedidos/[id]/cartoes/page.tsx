// Cartões da edição para imprimir (9 × 12 cm, um por peça do pedido): a
// mesma imagem que vai na caixa. Sem imagem ainda, a tela lista as peças e
// o botão desenha; gerar de novo refaz (uma nota da curadora escrita depois
// entra no cartão) — e a tela avisa quando o cartão ficou velho.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { getFileStorage } from "@/adapters/storage";
import { PrintButton } from "@/components/admin/print-button";
import { EDITION_CURATOR_MAX } from "@/core/edition/text";
import { getDb } from "@/db/client";
import { isOwner, requireUser } from "@/services/auth";
import { getEditionCards, ServiceError } from "@/services/edition-cards";
import { formatDateTimeSP } from "../../format";

import { CardsForm } from "./cards-form";

export const dynamic = "force-dynamic";
/** Até cinco cartões desenhados dentro da action desta página. */
export const maxDuration = 60;

export const metadata: Metadata = { title: "Cartões da edição" };

/**
 * Na impressão só os cartões aparecem, um por folha. Sem `position:absolute`
 * nem itens flex: o Safari só quebra página entre blocos em fluxo — a casca
 * do painel some com display:none e a lista vira blocos com break-before.
 */
const PRINT_CSS = `@media print {
  aside, header, nav, .print\\:hidden { display: none !important; }
  main { padding: 0 !important; overflow: visible !important; }
  .edition-print { display: block !important; }
  .edition-card { display: block !important; break-inside: avoid; page-break-inside: avoid; }
  .edition-card + .edition-card { break-before: page; page-break-before: always; }
  @page { margin: 1cm; }
}`;

export default async function EditionCardsPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  let cards;
  try {
    cards = await getEditionCards(getDb(), getFileStorage(), id);
  } catch (error) {
    if (error instanceof ServiceError && error.code === "pedido_nao_encontrado") notFound();
    throw error;
  }
  const owner = await isOwner();
  const generated = cards.at !== null;
  const warnings: string[] = [];
  if (generated && cards.stale) {
    warnings.push("A ficha ou a nota de uma peça mudou depois dos cartões — gere de novo antes de imprimir.");
  }
  if (cards.isGift) {
    warnings.push("Pedido presente: o QR dos cartões leva à página inicial da loja, não à peça com preço.");
  }
  for (const card of cards.cards) {
    if (!card.publicPage) {
      warnings.push(`A página de “${card.name}” está fora do ar (peça arquivada, excluída ou ainda escondida): o QR daria página não encontrada.`);
    }
    if (card.curatorTruncated) {
      warnings.push(`A frase da curadora de “${card.name}” não coube inteira (o cartão usa até ${EDITION_CURATOR_MAX} caracteres): sai até o fim da última frase que cabe.`);
    }
    if (card.careTruncated) {
      warnings.push(`Os cuidados de “${card.name}” não couberam inteiros: o texto escrito fica, e sobram só os pictogramas que cabem.`);
    }
  }
  for (const skip of cards.skipped) {
    warnings.push(`“${skip.name}” não é peça de roupa: fica sem cartão.`);
  }

  return (
    <div className="mx-auto max-w-3xl">
      <style>{PRINT_CSS}</style>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div>
          <Link href={`/admin/pedidos/${id}`} className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">
            ← Pedido #{cards.orderNumber}
          </Link>
          <h1 className="mt-1 text-xl font-semibold text-zinc-900 dark:text-zinc-100">Cartões da edição</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Um cartão por peça, 9 × 12 cm. Imprima em papel de gramatura alta, corte pela linha marfim e coloque dentro da caixa.
            {generated && cards.at ? ` Gerados em ${formatDateTimeSP(cards.at)}.` : ""}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <CardsForm orderId={id} generated={generated} stale={cards.stale} />
          {generated ? <PrintButton label="Imprimir cartões" /> : null}
        </div>
      </div>

      {warnings.length > 0 ? (
        <ul className="mb-6 flex flex-col gap-1 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 print:hidden dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}

      {cards.cards.length === 0 ? (
        <p className="text-sm text-zinc-500 print:hidden dark:text-zinc-400">
          {cards.skipped.length > 0 ? "Este pedido só tem itens que não são roupa: não há cartão." : "Este pedido não tem peças."}
        </p>
      ) : (
        <ul className="edition-print flex flex-col gap-8">
          {cards.cards.map((card) => (
            <li key={card.productId} className={card.url ? "edition-card flex flex-col items-center gap-2" : "flex flex-col items-center gap-2 print:hidden"}>
              {card.url ? (
                <img
                  src={card.url}
                  alt={`Cartão da edição: ${card.name}`}
                  className="block border border-zinc-200 bg-white print:border-0"
                  style={{ width: "9cm", height: "12cm" }}
                />
              ) : (
                <div
                  className="flex flex-col items-center justify-center gap-2 border border-dashed border-zinc-300 bg-white p-6 text-center text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900"
                  style={{ width: "9cm", height: "12cm" }}
                >
                  <span className="font-serif text-lg italic text-zinc-900 dark:text-zinc-100">{card.name}</span>
                  <span className="text-xs">Toque em “Gerar cartões”.</span>
                </div>
              )}
              <p className="text-xs text-zinc-500 print:hidden dark:text-zinc-400">
                {card.name}
                {card.stale ? " · ficou velho — gere de novo" : ""}
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
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
