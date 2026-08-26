import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { isEmailConfigured } from "@/adapters/email";
import { getDb } from "@/db/client";
import { requireOwner } from "@/services/auth";
import { ServiceError, getUserDetail } from "@/services/users";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Table, Td, Tr } from "@/components/ui/table";
import { dateTimeFormatter } from "../../clientes/format";
import {
  ROLE_LABELS,
  ROLE_TONES,
  STATUS_LABELS,
  STATUS_TONES,
  userActionLabel,
} from "../labels";
import { UserForm } from "../user-form";
import { ResetAccessForm, ToggleActiveForm } from "./user-actions";

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

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={detail.fullName ?? detail.email}
        subtitle={`No painel desde ${dateTimeFormatter.format(detail.createdAt)}`}
        actions={
          <Link
            href="/admin/usuarios"
            className="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
          >
            ← Voltar para usuários
          </Link>
        }
      />

      <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
        <span>{detail.email}</span>
        <span aria-hidden>·</span>
        <Badge tone={ROLE_TONES[detail.role]}>{ROLE_LABELS[detail.role]}</Badge>
        <Badge tone={STATUS_TONES[detail.status]}>
          {STATUS_LABELS[detail.status]}
        </Badge>
        {isSelf ? (
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            (este é o seu acesso)
          </span>
        ) : null}
      </div>

      <div className="grid items-start gap-6 xl:grid-cols-2">
        <Card title="Dados do usuário">
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
          <Card title="Acesso">
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

          <Card title="Histórico deste acesso">
            {detail.history.length === 0 ? (
              <EmptyState
                title="Nada registrado ainda"
                hint="Cadastro, mudanças de papel, ativações e redefinições de senha aparecem aqui."
              />
            ) : (
              <Table headers={["Quando", "O que aconteceu", "Quem fez"]}>
                {detail.history.map((entry) => (
                  <Tr key={entry.id}>
                    <Td className="whitespace-nowrap">
                      {dateTimeFormatter.format(entry.createdAt)}
                    </Td>
                    <Td>
                      {userActionLabel(entry.action)}
                      {entry.reason ? (
                        <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                          {entry.reason}
                        </span>
                      ) : null}
                    </Td>
                    <Td>{entry.actorName ?? entry.actorEmail ?? "—"}</Td>
                  </Tr>
                ))}
              </Table>
            )}
            <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
              Mostrando os 20 registros mais recentes. Senhas e links nunca são
              guardados aqui.
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}
