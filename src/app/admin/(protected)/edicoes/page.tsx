import type { Metadata } from "next";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Table, Td, Tr } from "@/components/ui/table";
import { editionPeriodLabel, isEditionCurrent, isEditionPast, isEditionUpcoming } from "@/core/city-editions";
import { getDb } from "@/db/client";
import { requireOwner } from "@/services/auth";
import { listCityEditions } from "@/services/city-editions";

import { EditionCreateForm } from "./forms";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Edições de Belém" };

function statusOf(edition: { isActive: boolean; startsOn: string | null; endsOn: string | null; hourStart: number | null; hourEnd: number | null }, now: Date) {
  if (!edition.isActive) return { label: "Desativada", tone: "neutral" as const };
  if (isEditionPast(edition, now)) return { label: "Encerrada", tone: "neutral" as const };
  if (isEditionUpcoming(edition, now)) return { label: "Em breve", tone: "info" as const };
  if (isEditionCurrent(edition, now)) return { label: "No ar", tone: "success" as const };
  return { label: "Fora do horário", tone: "warning" as const };
}

// Edições de Belém: a curadoria com data e lugar — "Edição Círio", "Chuva
// das 14h". A vigente aparece na home e vira chip na coleção; cada uma tem
// a sua página /belem/<slug>. Não é o cartão da caixa (Configurações).
export default async function EdicoesPage() {
  await requireOwner("edicoes");
  const editions = await listCityEditions(getDb());
  const now = new Date();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Edições de Belém"
        subtitle="A curadoria com data e lugar: frase de abertura, sua palavra, capa e as peças. A edição vigente abre a home e vira chip na coleção."
      />

      <Card title="Nova edição">
        <EditionCreateForm />
      </Card>

      <Card title="Todas as edições">
        {editions.length === 0 ? (
          <EmptyState title="Nenhuma edição ainda" hint="Crie a primeira acima — a Edição Círio, por exemplo, com vigência de 1 a 12 de outubro." />
        ) : (
          <Table headers={["Edição", "Situação", "Vigência", "Peças", "Endereço"]}>
            {editions.map((edition) => {
              const status = statusOf(edition, now);
              return (
                <Tr key={edition.id}>
                  <Td>
                    <Link href={`/admin/edicoes/${edition.id}`} className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
                      {edition.name}
                    </Link>
                    {edition.openingLine ? <span className="block text-xs text-zinc-500">{edition.openingLine}</span> : null}
                  </Td>
                  <Td>
                    <Badge tone={status.tone}>{status.label}</Badge>
                  </Td>
                  <Td className="whitespace-nowrap">{editionPeriodLabel(edition)}</Td>
                  <Td className="tabular-nums">{edition.productCount}</Td>
                  <Td>
                    <a href={`/belem/${edition.slug}`} target="_blank" rel="noopener noreferrer" className="text-xs text-zinc-600 hover:underline dark:text-zinc-400">
                      /belem/{edition.slug}
                    </a>
                  </Td>
                </Tr>
              );
            })}
          </Table>
        )}
      </Card>
    </div>
  );
}
