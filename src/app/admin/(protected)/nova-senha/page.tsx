import type { Metadata } from "next";
import { requireUser } from "@/services/auth";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { NewPasswordForm } from "./new-password-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Minha senha",
};

/**
 * Destino dos links de acesso (`/admin/acesso` já validou o token e abriu a
 * sessão) e também da opção "Minha senha" do menu. Fica sob (protected) de
 * propósito: link expirado não cria sessão, então o guard devolve a pessoa ao
 * login em vez de mostrar um formulário que não salvaria nada.
 */
export default async function NewPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ primeiro?: string }>;
}) {
  const user = await requireUser();
  const { primeiro } = await searchParams;
  const first = primeiro === "1";

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <PageHeader
        title={first ? "Defina sua senha para começar" : "Minha senha"}
        subtitle={
          first
            ? `Seu acesso é o e-mail ${user.email}. Falta só escolher a senha.`
            : "Escolha uma senha nova para entrar no painel."
        }
      />

      <Card>
        <div className="flex flex-col gap-4">
          <p className="text-sm text-zinc-600 dark:text-zinc-300">
            {first
              ? "Depois de definir a senha você volta para a tela de entrada e usa ela para acessar o painel."
              : "Ao salvar, você sai de todos os aparelhos conectados e entra de novo com a senha nova."}
          </p>
          <NewPasswordForm first={first} />
        </div>
      </Card>
    </div>
  );
}
