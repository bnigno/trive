import type { Metadata } from "next";
import Link from "next/link";

import { isEmailConfigured } from "@/adapters/email";
import { getDb } from "@/db/client";
import { requireOwner } from "@/services/auth";
import { listUsers } from "@/services/users";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { Table, Td, Tr } from "@/components/ui/table";
import { dateTimeFormatter } from "../clientes/format";
import {
  ROLE_LABELS,
  ROLE_TONES,
  STATUS_LABELS,
  STATUS_TONES,
} from "./labels";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Usuários",
};

const newUserButtonClasses =
  "inline-flex items-center justify-center rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500";

export default async function UsersPage() {
  await requireOwner("usuarios");

  const db = getDb();
  const people = await listUsers(db);
  const emailConfigured = isEmailConfigured();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Usuários do painel"
        subtitle="Quem entra no painel, com que papel e como recupera o acesso."
        actions={
          <Link href="/admin/usuarios/novo" className={newUserButtonClasses}>
            Novo usuário
          </Link>
        }
      />

      {emailConfigured ? null : (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          O envio de e-mails ainda não está ligado: convites e redefinições
          aparecem aqui na tela, para você copiar e mandar pelo WhatsApp.
        </p>
      )}

      <Table headers={["Nome", "E-mail", "Papel", "Situação", "Cadastrado em"]}>
        {people.map((person) => (
          <Tr key={person.id}>
            <Td>
              <Link
                href={`/admin/usuarios/${person.id}`}
                className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
              >
                {person.fullName ?? "Sem nome"}
              </Link>
            </Td>
            <Td>{person.email}</Td>
            <Td>
              <Badge tone={ROLE_TONES[person.role]}>
                {ROLE_LABELS[person.role]}
              </Badge>
            </Td>
            <Td>
              <Badge tone={STATUS_TONES[person.status]}>
                {STATUS_LABELS[person.status]}
              </Badge>
            </Td>
            <Td className="whitespace-nowrap">
              {dateTimeFormatter.format(person.createdAt)}
            </Td>
          </Tr>
        ))}
      </Table>

      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        “Convite pendente” é quem recebeu o link mas ainda não criou a senha.
        Ninguém é apagado: para tirar o acesso, desative a pessoa na página dela
        — o histórico de compras e ajustes continua guardado.
      </p>
    </div>
  );
}
