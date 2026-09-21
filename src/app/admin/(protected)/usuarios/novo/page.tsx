import type { Metadata } from "next";

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
        eyebrow="Usuários do painel"
        backHref="/admin/usuarios"
        backLabel="Todos os usuários"
        title="Novo usuário"
        subtitle="Cadastre quem vai usar o painel e escolha como essa pessoa recebe o acesso."
      />

      <Card>
        <UserForm emailConfigured={isEmailConfigured()} />
      </Card>
    </div>
  );
}
