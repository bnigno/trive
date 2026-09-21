import { Activity, MailOpen, MailWarning, Pencil, KeyRound, UserCheck, UserPlus, Users, UserX } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";

import { isEmailConfigured } from "@/adapters/email";
import { USER_STATUSES } from "@/core/auth/user-directory";
import { getDb } from "@/db/client";
import { formatDateSP, formatDateTimeSP, formatRelativeTimePtBR } from "@/lib/sp-format";
import { requireOwner } from "@/services/auth";
import { getUsersOverview, USER_ROLES, type UserListItem } from "@/services/users";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button-link";
import { StatCard } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterPills, type FilterPill } from "@/components/ui/filter-pills";
import { IconButtonLink } from "@/components/ui/icon-button";
import { PageHeader } from "@/components/ui/page-header";
import { SearchForm } from "@/components/ui/search-form";
import { Table, Td, Tr } from "@/components/ui/table";
import { ROLE_ICONS } from "./icons";
import {
  ROLE_LABELS,
  ROLE_TONES,
  STATUS_LABELS,
  STATUS_TONES,
  type UserRole,
  type UserStatus,
} from "./labels";
import { ToggleActiveForm } from "./toggle-active-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Usuários",
};

// Um parâmetro ruim não apaga os outros: cada campo cai sozinho para "sem filtro".
const searchParamsSchema = z.object({
  q: z.string().trim().max(120).optional().catch(undefined),
  role: z.enum(USER_ROLES).optional().catch(undefined),
  status: z.enum(USER_STATUSES).optional().catch(undefined),
});
type Filters = z.infer<typeof searchParamsSchema>;

function listHref(filters: Partial<Filters>): string {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.role) params.set("role", filters.role);
  if (filters.status) params.set("status", filters.status);
  const query = params.toString();
  return query ? `/admin/usuarios?${query}` : "/admin/usuarios";
}

function lastSeenLabel(person: UserListItem, now: Date): { text: string; title?: string } {
  if (person.lastSeenAt) {
    return {
      text: formatRelativeTimePtBR(person.lastSeenAt, now),
      title: `Visto por último em ${formatDateTimeSP(person.lastSeenAt)}`,
    };
  }
  if (person.status === "convite_pendente") return { text: "—", title: "Ainda não criou a senha" };
  return { text: "Nunca entrou" };
}

function RoleBadge({ role }: { role: UserRole }) {
  const Icon = ROLE_ICONS[role];
  return (
    <Badge tone={ROLE_TONES[role]}>
      <Icon aria-hidden="true" className="size-3" strokeWidth={2} />
      {ROLE_LABELS[role]}
    </Badge>
  );
}

function StatusBadge({ status }: { status: UserStatus }) {
  return (
    <Badge tone={STATUS_TONES[status]} dot>
      {STATUS_LABELS[status]}
    </Badge>
  );
}

function RowActions({ person, isSelf }: { person: UserListItem; isSelf: boolean }) {
  return (
    <div className="flex items-center justify-end gap-1">
      <IconButtonLink
        href={`/admin/usuarios/${person.id}#dados`}
        label="Editar dados"
        size="sm"
        icon={<Pencil aria-hidden="true" className="size-4" strokeWidth={1.75} />}
      />
      {person.isActive ? (
        <IconButtonLink
          href={`/admin/usuarios/${person.id}#acesso`}
          label="Redefinir senha"
          size="sm"
          icon={<KeyRound aria-hidden="true" className="size-4" strokeWidth={1.75} />}
        />
      ) : null}
      <ToggleActiveForm
        userId={person.id}
        isActive={person.isActive}
        isSelf={isSelf}
        variant="icon"
      />
    </div>
  );
}

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireOwner("usuarios");
  const filters = searchParamsSchema.parse(await searchParams);
  const now = new Date();

  const db = getDb();
  const { items, summary } = await getUsersOverview(db, { ...filters, now });
  const emailConfigured = isEmailConfigured();
  const filtering = Boolean(filters.q || filters.role || filters.status);

  const statusPills: FilterPill[] = [
    { label: "Todos", href: listHref({ ...filters, status: undefined }), active: !filters.status, count: summary.total },
    { label: "Ativos", href: listHref({ ...filters, status: "ativo" }), active: filters.status === "ativo", count: summary.active },
    { label: "Convite pendente", href: listHref({ ...filters, status: "convite_pendente" }), active: filters.status === "convite_pendente", count: summary.pendingInvites },
    { label: "Desativados", href: listHref({ ...filters, status: "desativado" }), active: filters.status === "desativado", count: summary.deactivated },
  ];
  const rolePills: FilterPill[] = [
    { label: "Qualquer papel", href: listHref({ ...filters, role: undefined }), active: !filters.role },
    { label: "Proprietários", href: listHref({ ...filters, role: "owner" }), active: filters.role === "owner" },
    { label: "Funcionários", href: listHref({ ...filters, role: "staff" }), active: filters.role === "staff" },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Gestão"
        title="Usuários do painel"
        subtitle="Quem entra no painel, com que papel e como recupera o acesso."
        actions={
          <ButtonLink
            href="/admin/usuarios/novo"
            icon={<UserPlus aria-hidden="true" className="size-4" strokeWidth={1.75} />}
          >
            Novo usuário
          </ButtonLink>
        }
      />

      {emailConfigured ? null : (
        <p className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <MailWarning aria-hidden="true" className="mt-0.5 size-4 shrink-0" strokeWidth={1.75} />
          <span>
            O envio de e-mails ainda não está ligado: convites e redefinições
            aparecem aqui na tela, para você copiar e mandar pelo WhatsApp.
          </span>
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <StatCard
          label="Com acesso"
          value={String(summary.active)}
          hint={`${summary.owners} ${summary.owners === 1 ? "proprietário" : "proprietários"} · ${summary.staff} ${summary.staff === 1 ? "funcionário" : "funcionários"}`}
          icon={<UserCheck aria-hidden="true" className="size-4" strokeWidth={1.75} />}
          href={listHref({ status: "ativo" })}
        />
        <StatCard
          label="Ativos nos últimos 7 dias"
          value={String(summary.activeLast7Days)}
          hint="Quem entrou no painel esta semana."
          icon={<Activity aria-hidden="true" className="size-4" strokeWidth={1.75} />}
        />
        <StatCard
          label="Convites pendentes"
          value={String(summary.pendingInvites)}
          tone={summary.pendingInvites > 0 ? "warning" : "neutral"}
          hint={
            summary.pendingInvites > 0
              ? "Ainda não criaram a senha — reenvie o link na página da pessoa."
              : "Todo mundo que foi convidado já criou a senha."
          }
          icon={<MailOpen aria-hidden="true" className="size-4" strokeWidth={1.75} />}
          href={listHref({ status: "convite_pendente" })}
        />
        <StatCard
          label="Desativados"
          value={String(summary.deactivated)}
          hint="Sem acesso, com o histórico guardado."
          icon={<UserX aria-hidden="true" className="size-4" strokeWidth={1.75} />}
          href={listHref({ status: "desativado" })}
        />
      </div>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <SearchForm
          action="/admin/usuarios"
          defaultValue={filters.q}
          placeholder="Buscar por nome ou e-mail"
          keep={{ role: filters.role, status: filters.status }}
          className="w-full lg:max-w-sm"
        />
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-4">
          <FilterPills aria-label="Filtrar por situação" items={statusPills} />
          <FilterPills aria-label="Filtrar por papel" items={rolePills} />
        </div>
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={<Users aria-hidden="true" className="size-5" strokeWidth={1.75} />}
          title={filtering ? "Ninguém com esse filtro" : "Nenhum usuário cadastrado"}
          hint={
            filtering
              ? "Tente outro nome ou limpe os filtros."
              : "Cadastre quem vai entrar no painel com você."
          }
          action={
            filtering ? (
              <ButtonLink href="/admin/usuarios" variant="outline" size="sm">
                Limpar filtros
              </ButtonLink>
            ) : (
              <ButtonLink href="/admin/usuarios/novo" size="sm">
                Novo usuário
              </ButtonLink>
            )
          }
        />
      ) : (
        <>
          <div className="hidden md:block">
            <Table
              headers={[
                "Pessoa",
                "Papel",
                "Situação",
                "Último acesso",
                "No painel desde",
                { label: "Ações", align: "right" },
              ]}
            >
              {items.map((person) => {
                const isSelf = person.id === actor.id;
                const seen = lastSeenLabel(person, now);
                return (
                  <Tr key={person.id} muted={!person.isActive}>
                    <Td>
                      <div className="flex items-center gap-3">
                        <Avatar name={person.fullName} fallback={person.email} />
                        <div className="min-w-0">
                          <Link
                            href={`/admin/usuarios/${person.id}`}
                            className="block truncate font-medium text-zinc-900 hover:underline dark:text-zinc-100"
                          >
                            {person.fullName ?? "Sem nome"}
                            {isSelf ? (
                              <span className="ml-1.5 text-xs font-normal text-zinc-500 dark:text-zinc-400">
                                (você)
                              </span>
                            ) : null}
                          </Link>
                          <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                            {person.email}
                          </p>
                        </div>
                      </div>
                    </Td>
                    <Td>
                      <RoleBadge role={person.role} />
                    </Td>
                    <Td>
                      <StatusBadge status={person.status} />
                    </Td>
                    <Td className="whitespace-nowrap">
                      <span title={seen.title}>{seen.text}</span>
                    </Td>
                    <Td className="whitespace-nowrap">
                      <span title={formatDateTimeSP(person.createdAt)}>
                        {formatDateSP(person.createdAt)}
                      </span>
                    </Td>
                    <Td align="right">
                      <RowActions person={person} isSelf={isSelf} />
                    </Td>
                  </Tr>
                );
              })}
            </Table>
          </div>

          <ul className="flex flex-col gap-3 md:hidden">
            {items.map((person) => {
              const isSelf = person.id === actor.id;
              const seen = lastSeenLabel(person, now);
              return (
                <li
                  key={person.id}
                  className={`rounded-xl border border-zinc-200/80 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900 ${person.isActive ? "" : "opacity-60"}`}
                >
                  <div className="flex items-start gap-3">
                    <Avatar name={person.fullName} fallback={person.email} size="lg" className="size-11 text-sm" />
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/admin/usuarios/${person.id}`}
                        className="block truncate font-medium text-zinc-900 dark:text-zinc-100"
                      >
                        {person.fullName ?? "Sem nome"}
                        {isSelf ? (
                          <span className="ml-1.5 text-xs font-normal text-zinc-500 dark:text-zinc-400">
                            (você)
                          </span>
                        ) : null}
                      </Link>
                      <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{person.email}</p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <RoleBadge role={person.role} />
                        <StatusBadge status={person.status} />
                      </div>
                    </div>
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                    <div>
                      <dt>Último acesso</dt>
                      <dd className="font-medium text-zinc-800 dark:text-zinc-200" title={seen.title}>
                        {seen.text}
                      </dd>
                    </div>
                    <div>
                      <dt>No painel desde</dt>
                      <dd className="font-medium text-zinc-800 dark:text-zinc-200">
                        {formatDateSP(person.createdAt)}
                      </dd>
                    </div>
                  </dl>
                  <div className="mt-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
                    <RowActions person={person} isSelf={isSelf} />
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        “Convite pendente” é quem recebeu o link mas ainda não criou a senha.
        Ninguém é apagado: para tirar o acesso, desative a pessoa — o histórico
        de compras e ajustes continua guardado.
      </p>
    </div>
  );
}
