// Lançamentos com janela VIP — só o dono: cria, escolhe as peças, calcula o
// público, agenda; o cron abre a janela VIP e publica na hora marcada.
import type { Metadata } from "next";
import Link from "next/link";

import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Table, Td, Tr } from "@/components/ui/table";
import { getDb } from "@/db/client";
import { requireOwner } from "@/services/auth";
import { listCityEditions } from "@/services/city-editions";
import { formatDropMoment, listDrops, type DropView } from "@/services/drops";

import { DropCreateForm } from "./forms";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Lançamentos" };

export const PHASE_LABEL: Record<DropView["phase"], { label: string; tone: BadgeTone }> = {
  draft: { label: "Rascunho", tone: "neutral" },
  scheduled: { label: "Agendado", tone: "info" },
  vip: { label: "Janela VIP aberta", tone: "warning" },
  published: { label: "Publicado", tone: "success" },
  canceled: { label: "Cancelado", tone: "neutral" },
};

export default async function LancamentosPage() {
  await requireOwner("lancamentos");
  const db = getDb();
  const [drops, editions] = await Promise.all([listDrops(db), listCityEditions(db)]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Lançamentos"
        subtitle="As peças ficam escondidas até a data; as clientes com mais afinidade veem primeiro e recebem um convite único."
      />

      <Card title="Novo lançamento">
        <DropCreateForm editions={editions.filter((e) => e.isActive).map((e) => ({ id: e.id, name: e.name }))} />
      </Card>

      <Card title="Todos os lançamentos">
        {drops.length === 0 ? (
          <EmptyState title="Nenhum lançamento ainda" hint="Crie o primeiro acima: nome, data de publicação, janela VIP e limite de convidadas." />
        ) : (
          <Table headers={["Lançamento", "Fase", "Janela VIP", "Publicação", "Peças", "Convidadas", "Quero ser avisada"]}>
            {drops.map((drop) => (
              <Tr key={drop.id}>
                <Td>
                  <Link href={`/admin/lancamentos/${drop.id}`} className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
                    {drop.name}
                  </Link>
                </Td>
                <Td>
                  <Badge tone={PHASE_LABEL[drop.phase].tone}>{PHASE_LABEL[drop.phase].label}</Badge>
                </Td>
                <Td className="whitespace-nowrap">{formatDropMoment(drop.vipStartsAt)}</Td>
                <Td className="whitespace-nowrap">{formatDropMoment(drop.publishAt)}</Td>
                <Td>{drop.products.length}</Td>
                <Td>
                  {drop.invites.total}
                  {drop.invites.sent > 0 ? ` · ${drop.invites.sent} enviadas` : ""}
                  {drop.invites.visited > 0 ? ` · ${drop.invites.visited} abriram` : ""}
                </Td>
                <Td className="tabular-nums">
                  {drop.waitlist.total}
                  {drop.waitlist.notified > 0 ? ` · ${drop.waitlist.notified} avisadas` : ""}
                </Td>
              </Tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
