import type { Metadata } from "next";
import Link from "next/link";

import { isEmailConfigured } from "@/adapters/email";
import { requireOwner } from "@/services/auth";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { UserForm } from "../user-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Novo usuário",
};

export default async function NewUserPage() {
  await requireOwner("usuarios");

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <PageHeader
        title="Novo usuário"
        subtitle="Cadastre quem vai usar o painel e escolha como essa pessoa recebe o acesso."
        actions={
          <Link
            href="/admin/usuarios"
            className="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
          >
            ← Voltar para usuários
          </Link>
        }
      />

      <Card>
        <UserForm emailConfigured={isEmailConfigured()} />
      </Card>
    </div>
  );
}
