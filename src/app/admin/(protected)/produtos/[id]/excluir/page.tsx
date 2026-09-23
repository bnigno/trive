// Aviso antes de excluir: nada de window.confirm, porque o aviso precisa dos
// números da peça (quantas fotos somem, quantas já foram vendidas, quem fica
// esperando). O estrago só acontece no botão desta tela.
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getDb } from "@/db/client";
import { requireOwner } from "@/services/auth";
import { describeProductDeletion } from "@/services/catalog-delete";
import { ServiceError } from "@/services/catalog";
import { ButtonLink } from "@/components/ui/button-link";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { DeleteProductForm } from "./delete-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Excluir peça",
};

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

export default async function ExcluirProdutoPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireOwner("produtos");
  const { id } = await params;

  let summary;
  try {
    summary = await describeProductDeletion(getDb(), id);
  } catch (error) {
    if (error instanceof ServiceError) notFound();
    throw error;
  }

  // Cada linha é um fato sobre ESTA peça. As que não se aplicam não aparecem:
  // uma lista de "nenhum" não avisa nada.
  const facts: string[] = [
    "Ela some da loja, da Lia, das buscas e das suas listas — na hora.",
  ];
  if (summary.photoCount > 0) {
    facts.push(
      `As ${summary.photoCount} ${plural(summary.photoCount, "foto será apagada", "fotos serão apagadas")} para sempre. Se a peça voltar, as fotos não voltam.`,
    );
  }
  if (summary.soldCount > 0) {
    facts.push(
      `Já ${plural(summary.soldCount, "foi vendida 1 vez", `foi vendida ${summary.soldCount} vezes`)}. Os pedidos e os relatórios continuam certos.`,
    );
  } else {
    facts.push("Nunca foi vendida.");
  }
  if (summary.onHand > 0) {
    facts.push(
      `Tem ${summary.onHand} em estoque; o saldo some junto com a peça.`,
    );
  }
  if (summary.activeHolds > 0) {
    facts.push(
      `${summary.activeHolds} ${plural(summary.activeHolds, "reserva gentil será liberada", "reservas gentis serão liberadas")}.`,
    );
  }
  if (summary.waitingAlerts > 0) {
    facts.push(
      `${summary.waitingAlerts} ${plural(summary.waitingAlerts, "cliente que pediu “me avisa quando voltar” não será avisada", "clientes que pediram “me avisa quando voltar” não serão avisadas")}.`,
    );
  }
  if (summary.linkedTo.length > 0) {
    facts.push(`Está em ${summary.linkedTo.join(", ")} — vou soltar esses vínculos.`);
  }
  facts.push(
    "Pode voltar em Produtos → Excluídas, como rascunho e sem as fotos.",
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Produtos"
        title={`Excluir «${summary.name}»?`}
        subtitle={
          summary.skus.length > 0
            ? `Código: ${summary.skus.join(", ")}`
            : "Peça sem variações cadastradas."
        }
        backHref={`/admin/produtos/${summary.productId}`}
        backLabel="Voltar para a peça"
      />

      {summary.openOrderCount > 0 ? (
        <p
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm font-medium text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300"
        >
          Atenção: {summary.openOrderCount}{" "}
          {plural(
            summary.openOrderCount,
            "pedido em andamento tem esta peça",
            "pedidos em andamento têm esta peça",
          )}
          . Confira antes de excluir — o pedido continua certo, mas você não
          acha mais a peça no painel para conferir.
        </p>
      ) : null}

      <Card title="O que vai acontecer">
        <ul className="flex list-disc flex-col gap-2 pl-5 text-sm text-zinc-700 dark:text-zinc-300">
          {facts.map((fact) => (
            <li key={fact}>{fact}</li>
          ))}
        </ul>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <DeleteProductForm
            productId={summary.productId}
            productName={summary.name}
          />
          <ButtonLink
            href={`/admin/produtos/${summary.productId}`}
            variant="outline"
            size="sm"
          >
            Cancelar
          </ButtonLink>
        </div>
      </Card>
    </div>
  );
}
