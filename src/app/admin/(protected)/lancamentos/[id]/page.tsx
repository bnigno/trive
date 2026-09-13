import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, isNull, ne } from "drizzle-orm";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { CopyField } from "@/components/ui/copy-field";
import { Money } from "@/components/ui/money";
import { PageHeader } from "@/components/ui/page-header";
import { Table, Td, Tr } from "@/components/ui/table";
import { getFileStorage } from "@/adapters/storage";
import { canSchedule, publicDropLabel } from "@/core/drops";
import { getDb } from "@/db/client";
import { siteUrl } from "@/lib/site-url";
import { products } from "@/db/schema";
import { requireOwner } from "@/services/auth";
import { formatDropMoment, getDrop, getDropReport } from "@/services/drops";

import { AudiencePreviewForm, CancelDropForm, DropEditForm, DropProductsForm, DropStoryForm, ScheduleDropForm } from "../forms";
import { PHASE_LABEL } from "../page";

export const dynamic = "force-dynamic";
// A action "Gerar story" desenha 1080×1920 com até 3 fotos (Satori + sharp):
// pode passar de 10 s a frio.
export const maxDuration = 60;

export const metadata: Metadata = { title: "Lançamento" };

/** Date → 'AAAA-MM-DDTHH:mm' no horário de São Paulo (input datetime-local). */
function toSpLocalInput(date: Date): string {
  const sp = new Date(date.getTime() - 3 * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${sp.getUTCFullYear()}-${pad(sp.getUTCMonth() + 1)}-${pad(sp.getUTCDate())}T${pad(sp.getUTCHours())}:${pad(sp.getUTCMinutes())}`;
}

export default async function LancamentoPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner("lancamentos");
  const { id } = await params;
  const db = getDb();
  const storage = getFileStorage();
  const drop = await getDrop(db, id);
  if (!drop) notFound();

  const editable = drop.status === "draft";
  const check = canSchedule({ publishAt: drop.publishAt, vipWindowHours: drop.vipWindowHours, products: drop.products }, new Date());
  const options = await db
    .select({ id: products.id, name: products.name, status: products.status })
    .from(products)
    .where(and(isNull(products.deletedAt), ne(products.status, "archived")))
    .orderBy(asc(products.name))
    .limit(300);
  const factsById = new Map(drop.products.map((p) => [p.id, p]));
  const report = drop.invites.total > 0 ? await getDropReport(db, drop.id) : null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={drop.name}
        subtitle={`Janela VIP ${formatDropMoment(drop.vipStartsAt)} · publicação ${formatDropMoment(drop.publishAt)}`}
        actions={
          <div className="flex items-center gap-3">
            <Badge tone={PHASE_LABEL[drop.phase].tone}>{PHASE_LABEL[drop.phase].label}</Badge>
            <Link href="/admin/lancamentos" className="text-sm text-zinc-500 hover:underline dark:text-zinc-400">
              Voltar
            </Link>
          </div>
        }
      />

      <div className="grid items-start gap-6 xl:grid-cols-2">
        <div className="flex flex-col gap-6">
          <Card title="Dados">
            <DropEditForm
              drop={{ id: drop.id, name: drop.name, vipWindowHours: drop.vipWindowHours, audienceLimit: drop.audienceLimit, messageOverride: drop.messageOverride }}
              publishAtLocal={toSpLocalInput(drop.publishAt)}
              editable={editable}
            />
          </Card>
          <Card title={`Peças (${drop.products.length})`}>
            <DropProductsForm
              dropId={drop.id}
              options={options.map((option) => {
                const facts = factsById.get(option.id);
                const hints = facts
                  ? [!facts.hasActivePrice ? "sem preço" : null, !facts.hasStock ? "sem estoque" : null, !facts.hasPhoto ? "sem foto" : null].filter(Boolean)
                  : [];
                return { id: option.id, name: option.name, status: option.status, hint: hints.length > 0 ? hints.join(", ") : null };
              })}
              selected={drop.products.map((p) => p.id)}
              editable={editable}
            />
          </Card>
        </div>

        <div className="flex flex-col gap-6">
          {drop.status === "draft" ? (
            <>
              <Card title="Público por afinidade">
                <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
                  Clientes com opt-in cuja cartela (tamanho, cores) ou histórico de compras conversa com as peças. Só quem soma 2 pontos ou mais entra.
                </p>
                <AudiencePreviewForm dropId={drop.id} />
              </Card>
              <Card title="Agendar">
                <ScheduleDropForm dropId={drop.id} problems={check.problems} />
              </Card>
            </>
          ) : null}

          {drop.status === "scheduled" || drop.status === "vip_sent" ? (
            <Card title="Cancelar">
              <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
                Cancelar desfaz o agendamento e as peças deixam de ficar escondidas. Convites já enviados não são apagados do WhatsApp das clientes.
              </p>
              <CancelDropForm dropId={drop.id} />
            </Card>
          ) : null}

          {drop.phase !== "draft" && drop.phase !== "canceled" ? (
            <Card title="Estreia pública">
              <div className="flex flex-col gap-4">
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                  {drop.phase === "published"
                    ? `A cortina abriu. ${drop.waitlist.total} ${drop.waitlist.total === 1 ? "pessoa pediu" : "pessoas pediram"} aviso; ${drop.waitlist.notified} já ${drop.waitlist.notified === 1 ? "recebeu" : "receberam"} (as demais recebem dentro da janela de envio, uma por vez).`
                    : `Em trivemaison.com.br/estreia qualquer pessoa vê a contagem e as silhuetas das peças, e deixa o WhatsApp para ser avisada na hora. ${drop.waitlist.total} ${drop.waitlist.total === 1 ? "pessoa já pediu" : "pessoas já pediram"}.`}
                </p>
                <CopyField
                  label="Link público da estreia"
                  value={`${siteUrl()}/estreia`}
                  hint="Cole na bio e nos stories. Na hora marcada a página abre sozinha; o aviso no WhatsApp vai das 9h às 21h — estreia fora desse horário avisa na manhã seguinte."
                />
              </div>
            </Card>
          ) : null}

          {drop.phase !== "draft" && drop.phase !== "canceled" ? (
            <Card title="Story para o Instagram">
              <div className="flex flex-col gap-4">
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                  Imagem 1080×1920 no padrão dos cartões: “ESTREIA · {publicDropLabel(drop.publishAt, new Date()).toUpperCase()}”, as peças e o endereço /estreia. Ao gerar, a imagem chega no seu WhatsApp para salvar e postar.
                </p>
                <div className="grid gap-4 sm:grid-cols-2">
                  {(["teaser", "open"] as const).map((variant) => {
                    const path = variant === "teaser" ? drop.storyTeaserPath : drop.storyOpenPath;
                    return (
                      <div key={variant} className="flex flex-col gap-2">
                        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                          {variant === "teaser" ? "Atrás do véu (antes)" : "Cortina aberta (na hora)"}
                        </p>
                        {path ? (
                          <a href={`${storage.publicUrl(path)}?v=${drop.updatedAt.getTime()}`} target="_blank" rel="noopener noreferrer">
                            <img
                              src={`${storage.publicUrl(path)}?v=${drop.updatedAt.getTime()}`}
                              alt={`Story ${variant === "teaser" ? "do véu" : "aberto"} do lançamento`}
                              className="aspect-[9/16] w-full max-w-[220px] rounded-md border border-zinc-200 object-cover dark:border-zinc-700"
                            />
                          </a>
                        ) : (
                          <div className="flex aspect-[9/16] w-full max-w-[220px] items-center justify-center rounded-md border border-dashed border-zinc-300 text-xs text-zinc-400 dark:border-zinc-700">
                            ainda não gerado
                          </div>
                        )}
                        <DropStoryForm dropId={drop.id} variant={variant} hasImage={Boolean(path)} />
                      </div>
                    );
                  })}
                </div>
              </div>
            </Card>
          ) : null}

          {report ? (
            <Card title="Relatório">
              <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
                {[
                  ["Convidadas", String(report.invites)],
                  ["Enviadas", String(report.sent)],
                  ["Abriram", String(report.visited)],
                  ["Pedidos", String(report.orders)],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-xs uppercase tracking-wide text-zinc-500">{label}</dt>
                    <dd className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{value}</dd>
                  </div>
                ))}
                <div>
                  <dt className="text-xs uppercase tracking-wide text-zinc-500">Receita</dt>
                  <dd className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                    <Money cents={report.revenueCents} />
                  </dd>
                </div>
              </dl>
              <div className="mt-4">
                <Table headers={["Cliente", "Afinidade", "Convite", "Abriu"]}>
                  {report.rows.map((row) => (
                    <Tr key={row.customerId}>
                      <Td>
                        <Link href={`/admin/clientes/${row.customerId}`} className="text-indigo-600 hover:underline dark:text-indigo-400">
                          {row.fullName}
                        </Link>
                      </Td>
                      <Td>
                        {row.score} pts
                        {row.reasons.length > 0 ? <span className="block text-xs text-zinc-500">{row.reasons.join(" · ")}</span> : null}
                      </Td>
                      <Td className="whitespace-nowrap">{row.sentAt ? formatDropMoment(row.sentAt) : "—"}</Td>
                      <Td className="whitespace-nowrap">{row.firstVisitAt ? formatDropMoment(row.firstVisitAt) : "—"}</Td>
                    </Tr>
                  ))}
                </Table>
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
