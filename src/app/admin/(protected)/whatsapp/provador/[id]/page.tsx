// A sala do Provador: o calendário da semana (terça, quinta, sábado), o
// compositor dos rituais com pré-visualização exata, os posts que saíram
// com o que o grupo devolveu (reações, votos, toques → conversas → pedidos),
// as membras e a saúde da sala.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { Table, Td, Tr } from "@/components/ui/table";
import { type GroupPostKind, nextRitualDay, ritualHour } from "@/core/groups/cadence";
import { getDb } from "@/db/client";
import { maskPhone } from "@/lib/phone";
import { spDayKey, spDayLabel, spTimeLabel } from "@/lib/sp-day";
import { requireOwner } from "@/services/auth";
import { listProducts } from "@/services/catalog";
import { listPublicLooks } from "@/services/customer-looks";
import {
  getGroup,
  getGroupPostStats,
  type GroupMemberView,
  type GroupPostStats,
  type GroupPostView,
  type GroupView,
  listGroupMembers,
  listGroupPosts,
  loadGroupPolicy,
} from "@/services/wa-groups";

import { cancelPostAction, closePollAction } from "../actions";
import { ComposePostForm, type LookOption, type ProductOption, type RitualDefaults } from "../forms";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sala do Provador",
};

const KIND_LABEL: Record<string, string> = {
  chegadas: "Passou pelo Provador",
  enquete: "Vocês decidem",
  quem_vestiu: "Quem vestiu",
  cortina: "Cortina",
  livre: "Post livre",
};

const STATUS_LABEL: Record<string, { label: string; tone: "neutral" | "success" | "warning" | "danger" | "info" }> = {
  draft: { label: "Rascunho", tone: "neutral" },
  scheduled: { label: "Agendado", tone: "info" },
  sent: { label: "Enviado", tone: "success" },
  skipped: { label: "Pulado", tone: "warning" },
  canceled: { label: "Cancelado", tone: "neutral" },
};

const SKIP_LABEL: Record<string, string> = {
  provador_desligado: "Provador desligado na hora",
  desabilitado: "WhatsApp desligado na hora",
  sala_inativa: "sala desligada",
  sala_pausada: "sala pausada",
};

type PageData = {
  group: GroupView;
  posts: (GroupPostView & { stats: GroupPostStats })[];
  members: GroupMemberView[];
  leftLast7: number;
  joinedLast7: number;
  products: ProductOption[];
  looks: LookOption[];
  defaults: RitualDefaults;
  windowLabel: string;
  groupsEnabled: boolean;
};

async function loadData(groupId: string): Promise<PageData | null> {
  const db = getDb();
  const group = await getGroup(db, groupId);
  if (!group) return null;
  const now = new Date();
  const [posts, members, allMembers, products, looks, policy] = await Promise.all([
    listGroupPosts(db, { groupId, limit: 30 }),
    listGroupMembers(db, { groupId }),
    listGroupMembers(db, { groupId, includeLeft: true }),
    listProducts(db, { status: "active" }),
    listPublicLooks(db),
    loadGroupPolicy(db),
  ]);
  const withStats = await Promise.all(posts.map(async (post) => ({ ...post, stats: await getGroupPostStats(db, post.id) })));
  const weekAgo = now.getTime() - 7 * 86_400_000;
  const defaults = Object.fromEntries(
    (["chegadas", "enquete", "quem_vestiu", "livre"] as const).map((kind) => [
      kind,
      { day: nextRitualDay(kind as GroupPostKind, now, policy.cadence), time: `${String(ritualHour(kind as GroupPostKind)).padStart(2, "0")}:00` },
    ]),
  ) as RitualDefaults;
  return {
    group,
    posts: withStats,
    members,
    leftLast7: allMembers.filter((m) => m.leftAt && m.leftAt.getTime() >= weekAgo).length,
    joinedLast7: members.filter((m) => m.joinedAt.getTime() >= weekAgo).length,
    products: products
      .map((product) => {
        const available = product.totalOnHand - product.totalReserved;
        const noPrice = product.minActivePriceCents === null;
        return {
          id: product.id,
          name: product.name,
          hint: noPrice ? "sem preço" : available <= 0 ? "sem estoque" : `${available} em estoque`,
          disabled: noPrice || available <= 0,
        };
      })
      .sort((a, b) => Number(a.disabled) - Number(b.disabled) || a.name.localeCompare(b.name, "pt-BR")),
    looks: looks.map((look) => ({ id: look.id, label: `${look.displayName} veste ${look.productName}` })),
    defaults,
    windowLabel: `${policy.cadence.window.startHour}h às ${policy.cadence.window.endHour}h`,
    groupsEnabled: policy.groupsEnabled,
  };
}

function whenLabel(post: GroupPostView): string {
  const when = post.sentAt ?? post.scheduledAt;
  if (!when) return "—";
  return `${spDayLabel(spDayKey(when))}, ${spTimeLabel(when)}`;
}

export default async function ProvadorRoomPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner("whatsapp");
  const { id } = await params;
  const data = await loadData(id);
  if (!data) notFound();
  const { group, posts, members } = data;
  const now = new Date();
  const paused = group.pausedUntil && group.pausedUntil.getTime() > now.getTime();
  const withProfile = members.filter((m) => m.hasProfile).length;
  const withOptIn = members.filter((m) => m.marketingOptIn).length;
  const sentLast7 = posts.filter((p) => p.status === "sent" && p.sentAt && p.sentAt.getTime() >= now.getTime() - 7 * 86_400_000);
  const signalsLast7 = sentLast7.reduce((sum, p) => sum + p.stats.reactions + p.stats.votes + p.stats.mentions + p.stats.taps, 0);
  const responseRate = members.length > 0 && sentLast7.length > 0 ? Math.round((signalsLast7 / (members.length * sentLast7.length)) * 100) : null;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={group.name}
        subtitle={`${group.memberCount} ${group.memberCount === 1 ? "membra" : "membras"} · ${withProfile} com cartela · ${withOptIn} com opt-in`}
        actions={
          <Link
            href="/admin/whatsapp/provador"
            className="inline-flex items-center justify-center rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Todas as salas
          </Link>
        }
      />

      {!data.groupsEnabled ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          O Provador está desligado: dá para agendar, mas nada sai e nada é lido até ligar em <Link href="/admin/whatsapp/provador" className="underline">Provador › Ligar e desligar</Link>.
        </p>
      ) : null}
      {paused ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          Sala pausada até {spDayLabel(spDayKey(group.pausedUntil!))}{group.pausedReason ? ` — ${group.pausedReason}` : ""}. Posts na hora marcada ficam como pulados; retome na lista de salas.
        </p>
      ) : null}

      <Card title="Saúde da sala">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div>
            <dt className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Membras</dt>
            <dd className="text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{members.length}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Entraram (7 dias)</dt>
            <dd className="text-2xl font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">{data.joinedLast7}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Saíram (7 dias)</dt>
            <dd className={`text-2xl font-semibold tabular-nums ${data.leftLast7 > 0 ? "text-amber-600 dark:text-amber-400" : "text-zinc-900 dark:text-zinc-100"}`}>{data.leftLast7}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Resposta (7 dias)</dt>
            <dd className="text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{responseRate === null ? "—" : `${responseRate}%`}</dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
          Resposta = reações + votos + menções + toques nos posts da semana, por membra. A sala pausa sozinha quando mais de 2% saem nas 24 h depois de um post.
        </p>
      </Card>

      <Card title="Agendar um ritual">
        <ComposePostForm groupId={group.id} products={data.products} looks={data.looks} defaults={data.defaults} windowLabel={data.windowLabel} />
      </Card>

      <Card title="Posts">
        {posts.length === 0 ? (
          <EmptyState title="Nenhum post ainda" hint="Agende o primeiro “Passou pelo Provador” acima: terça, 10h, com até 3 peças." />
        ) : (
          <div className="flex flex-col gap-4">
            <Table headers={["Quando", "Ritual", "Status", "Reações", "Votos", "Toques → conversas → pedidos", "Ações"]}>
              {posts.map((post) => {
                const status = STATUS_LABEL[post.status] ?? { label: post.status, tone: "neutral" as const };
                return (
                  <Tr key={post.id}>
                    <Td className="whitespace-nowrap">{whenLabel(post)}</Td>
                    <Td>
                      <span className="font-medium">{KIND_LABEL[post.kind] ?? post.kind}</span>
                      {post.campaignSlug ? <span className="block font-mono text-xs text-zinc-500 dark:text-zinc-400">/ig/{post.campaignSlug}</span> : null}
                    </Td>
                    <Td>
                      <Badge tone={status.tone}>{status.label}</Badge>
                      {post.status === "skipped" && post.skippedReason ? (
                        <span className="block text-xs text-zinc-500 dark:text-zinc-400">{SKIP_LABEL[post.skippedReason] ?? post.skippedReason}</span>
                      ) : null}
                      {post.kind === "enquete" && post.pollClosedAt ? (
                        <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                          {post.pollResult?.winner ? `Deu ${post.pollResult.winner} (${post.pollResult.voters} ${post.pollResult.voters === 1 ? "voto" : "votos"})` : "apurada sem votos"}
                        </span>
                      ) : null}
                    </Td>
                    <Td className="tabular-nums">{post.stats.reactions}</Td>
                    <Td className="tabular-nums">{post.kind === "enquete" ? post.stats.votes : "—"}</Td>
                    <Td className="tabular-nums">
                      {post.stats.taps} → {post.stats.conversations} → {post.stats.orders}
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-2">
                        {post.status === "scheduled" ? (
                          <form action={cancelPostAction}>
                            <input type="hidden" name="postId" value={post.id} />
                            <input type="hidden" name="groupId" value={group.id} />
                            <ConfirmButton size="sm" variant="outline" confirmMessage="Cancelar este post? Ele não sai e o dia fica livre.">
                              Cancelar
                            </ConfirmButton>
                          </form>
                        ) : null}
                        {post.kind === "enquete" && post.status === "sent" && !post.pollClosedAt ? (
                          <form action={closePollAction}>
                            <input type="hidden" name="postId" value={post.id} />
                            <input type="hidden" name="groupId" value={group.id} />
                            <Button type="submit" size="sm" variant="outline">
                              Apurar agora
                            </Button>
                          </form>
                        ) : null}
                      </div>
                    </Td>
                  </Tr>
                );
              })}
            </Table>
            <div className="flex flex-col gap-2">
              {posts.slice(0, 6).map((post) => (
                <details key={post.id} className="rounded-lg border border-zinc-200 dark:border-zinc-800">
                  <summary className="cursor-pointer px-4 py-2 text-sm text-zinc-700 dark:text-zinc-300">
                    {KIND_LABEL[post.kind] ?? post.kind} — {whenLabel(post)}: ver o texto
                  </summary>
                  <pre className="whitespace-pre-wrap border-t border-zinc-200 p-4 font-sans text-sm text-zinc-800 dark:border-zinc-800 dark:text-zinc-200">
                    {post.body}
                    {post.pollOptions ? `\n\n${post.pollOptions.map((option) => `○ ${option}`).join("\n")}` : ""}
                  </pre>
                </details>
              ))}
            </div>
          </div>
        )}
      </Card>

      <Card title="Membras">
        {members.length === 0 ? (
          <EmptyState title="Ninguém ainda" hint="Sincronize a sala na lista de salas para ler as participantes do grupo." />
        ) : (
          <Table headers={["Quem", "Cadastro", "Cartela", "Opt-in", "Entrou", "Como"]}>
            {members.map((member) => (
              <Tr key={member.id}>
                <Td>
                  {member.customerName ?? maskPhone(member.phoneE164)}
                  {member.isAdmin ? <Badge tone="neutral">admin</Badge> : null}
                </Td>
                <Td>
                  {member.customerId ? (
                    <Link href={`/admin/clientes/${member.customerId}`} className="hover:underline">
                      ver
                    </Link>
                  ) : (
                    <span className="text-zinc-500">—</span>
                  )}
                </Td>
                <Td>{member.hasProfile ? <Badge tone="success">sim</Badge> : <span className="text-zinc-500">—</span>}</Td>
                <Td>{member.marketingOptIn ? <Badge tone="success">sim</Badge> : <span className="text-zinc-500">—</span>}</Td>
                <Td className="whitespace-nowrap">{spDayLabel(spDayKey(member.joinedAt))}</Td>
                <Td>{member.source === "lia" ? "pela Lia" : member.source === "link" ? "pelo link" : "já estava"}</Td>
              </Tr>
            ))}
          </Table>
        )}
        <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
          Sem cartela e sem opt-in, a membra vê os posts do grupo mas não recebe nada no privado. A porta de entrada pela Lia (próximo passo) resolve os dois de uma vez.
        </p>
      </Card>
    </div>
  );
}
