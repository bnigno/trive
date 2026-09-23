import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { getFileStorage } from "@/adapters/storage";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { editionPeriodLabel, isEditionCurrent } from "@/core/city-editions";
import { getDb } from "@/db/client";
import { requireOwner } from "@/services/auth";
import { getCityEdition, listEditionProductChoices } from "@/services/city-editions";
import { getSettingsMap } from "@/services/settings";

import { EditionCoverForm, EditionEditForm, EditionProductsForm, UseOnCardsForm } from "../forms";

export const dynamic = "force-dynamic";
// A capa passa pelo sharp (até 8 MB): folga para foto de câmera a frio.
export const maxDuration = 60;

export const metadata: Metadata = { title: "Edição de Belém" };

export default async function EdicaoPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner("edicoes");
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const db = getDb();
  const [edition, options, settings] = await Promise.all([getCityEdition(db, id), listEditionProductChoices(db), getSettingsMap(db, ["edition_name"])]);
  if (!edition) notFound();
  const now = new Date();
  const coverUrl = edition.coverPath ? `${getFileStorage().publicUrl(edition.coverPath)}?v=${edition.updatedAt.getTime()}` : null;
  const cardsName = typeof settings.edition_name === "string" ? settings.edition_name : "";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={edition.name}
        subtitle={`${editionPeriodLabel(edition)} · ${edition.products.length} ${edition.products.length === 1 ? "peça" : "peças"}`}
        actions={
          <div className="flex items-center gap-3">
            {edition.isActive && isEditionCurrent(edition, now) ? <Badge tone="success">No ar</Badge> : null}
            <a href={`/belem/${edition.slug}`} target="_blank" rel="noopener noreferrer" className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">
              Ver /belem/{edition.slug}
            </a>
            <Link href="/admin/edicoes" className="text-sm text-zinc-600 hover:underline dark:text-zinc-400">
              ← Edições
            </Link>
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <Card title="Dados da edição">
            <EditionEditForm
              editionId={edition.id}
              values={{
                name: edition.name,
                slug: edition.slug,
                openingLine: edition.openingLine,
                body: edition.body,
                districts: edition.districts,
                startsOn: edition.startsOn,
                endsOn: edition.endsOn,
                hourStart: edition.hourStart,
                hourEnd: edition.hourEnd,
                sortOrder: edition.sortOrder,
                isActive: edition.isActive,
              }}
            />
          </Card>

          <Card title="Peças da edição">
            <EditionProductsForm
              editionId={edition.id}
              options={options}
              selected={edition.products.map((p) => ({ id: p.id, name: p.name, status: p.status }))}
            />
          </Card>
        </div>

        <div className="flex flex-col gap-6">
          <Card title="Capa">
            {coverUrl ? (
               
              <img src={coverUrl} alt={`Capa da ${edition.name}`} className="mb-3 aspect-[4/3] w-full rounded-md object-cover" />
            ) : (
              <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">Sem capa ainda — a home usa a primeira peça no lugar.</p>
            )}
            <EditionCoverForm editionId={edition.id} />
          </Card>

          <Card title="Cartões e posts">
            <UseOnCardsForm editionId={edition.id} name={edition.name} currentCardsName={cardsName} />
            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
              O nome que sai no cartão da caixa e nos posts é um ajuste separado (Configurações › Edição) — este botão só copia o nome daqui para lá.
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}
