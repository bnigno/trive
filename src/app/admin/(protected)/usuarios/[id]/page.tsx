import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";

import { isEmailConfigured } from "@/adapters/email";
import { getDb } from "@/db/client";
import { formatDateSP, formatDateTimeSP, formatRelativeTimePtBR } from "@/lib/sp-format";
import { requireOwner } from "@/services/auth";
import { ServiceError, getUserDetail } from "@/services/users";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { ROLE_ICONS, userActionIcon } from "../icons";
import {
  ROLE_LABELS,
  ROLE_TONES,
  STATUS_LABELS,
  STATUS_TONES,
  userActionLabel,
} from "../labels";
import { ToggleActiveForm } from "../toggle-active-form";
import { UserForm } from "../user-form";
import { ResetAccessForm } from "./user-actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Usuário",
};

type Detail = Awaited<ReturnType<typeof getUserDetail>>;

export default async function UserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await requireOwner("usuarios");
  const { id } = await params;

  const db = getDb();
  let detail: Detail;
  try {
    detail = await getUserDetail(db, id);
  } catch (error) {
    if (
      error instanceof z.ZodError ||
      (error instanceof ServiceError && error.code === "nao_encontrado")
    ) {
      notFound();
    }
    throw error;
  }

  const isSelf = detail.id === actor.id;
  const now = new Date();
  const RoleIcon = ROLE_ICONS[detail.role];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start gap-4">
        <Avatar
          name={detail.fullName}
          fallback={detail.email}
          size="lg"
          className="mt-1"
        />
        <div className="min-w-0 flex-1">
          <PageHeader
            eyebrow="Usuários do painel"
            backHref="/admin/usuarios"
            backLabel="Todos os usuários"
            title={detail.fullName ?? detail.email}
            subtitle={detail.email}
          />
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
            <Badge tone={ROLE_TONES[detail.role]}>
              <RoleIcon aria-hidden="true" className="size-3" strokeWidth={2} />
              {ROLE_LABELS[detail.role]}
            </Badge>
            <Badge tone={STATUS_TONES[detail.status]} dot>
              {STATUS_LABELS[detail.status]}
            </Badge>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              No painel desde {formatDateSP(detail.createdAt)}
            </span>
            {detail.lastSeenAt ? (
              <span
                className="text-xs text-zinc-500 dark:text-zinc-400"
                title={`Visto por último em ${formatDateTimeSP(detail.lastSeenAt)}`}
              >
                · Último acesso {formatRelativeTimePtBR(detail.lastSeenAt, now)}
              </span>
            ) : null}
            {isSelf ? (
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                · este é o seu acesso
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="grid items-start gap-6 xl:grid-cols-2">
        <Card id="dados" title="Dados do usuário" description="Nome e papel. O e-mail é a chave do acesso.">
          <UserForm
            emailConfigured={isEmailConfigured()}
            initial={{
              id: detail.id,
              email: detail.email,
              fullName: detail.fullName ?? "",
              role: detail.role,
            }}
          />
        </Card>

        <div className="flex flex-col gap-6">
          <Card id="acesso" title="Acesso" description="Nova senha por link ou provisória; ligar e desligar a entrada.">
            <div className="flex flex-col gap-5">
              <ResetAccessForm
                userId={detail.id}
                isActive={detail.isActive}
                emailConfigured={isEmailConfigured()}
              />

              <div className="border-t border-zinc-200 pt-5 dark:border-zinc-800">
                <ToggleActiveForm
                  userId={detail.id}
                  isActive={detail.isActive}
                  isSelf={isSelf}
                />
              </div>
            </div>
          </Card>

          <Card title="Histórico deste acesso" description="Os 20 registros mais recentes. Senhas e links nunca são guardados aqui.">
            {detail.history.length === 0 ? (
              <EmptyState
                title="Nada registrado ainda"
                hint="Cadastro, mudanças de papel, ativações e redefinições de senha aparecem aqui."
              />
            ) : (
              <ol className="flex flex-col">
                {detail.history.map((entry) => {
                  const Icon = userActionIcon(entry.action);
                  return (
                    <li
                      key={entry.id}
                      className="flex gap-3 border-b border-zinc-100 py-3 first:pt-0 last:border-b-0 last:pb-0 dark:border-zinc-800"
                    >
                      <span
                        aria-hidden="true"
                        className="mt-0.5 inline-grid size-7 shrink-0 place-items-center rounded-full bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                      >
                        <Icon className="size-3.5" strokeWidth={1.75} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-zinc-800 dark:text-zinc-200">
                          {userActionLabel(entry.action)}
                        </p>
                        {entry.reason ? (
                          <p className="text-xs text-zinc-500 dark:text-zinc-400">{entry.reason}</p>
                        ) : null}
                        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                          <time
                            dateTime={entry.createdAt.toISOString()}
                            title={formatDateTimeSP(entry.createdAt)}
                          >
                            {formatRelativeTimePtBR(entry.createdAt, now)}
                          </time>
                          {" · "}
                          {entry.actorName ?? entry.actorEmail ?? "—"}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
