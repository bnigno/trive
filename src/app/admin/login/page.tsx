import type { Metadata } from "next";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Entrar",
};

const NOTICE_BY_REASON: Record<string, string> = {
  "nao-autorizado":
    "Sua conta não tem acesso ao painel. Fale com o responsável pela loja.",
  inativo: "Sua conta está desativada. Fale com o responsável pela loja.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ motivo?: string }>;
}) {
  const { motivo } = await searchParams;
  const notice = motivo ? NOTICE_BY_REASON[motivo] : undefined;

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <LoginForm notice={notice} />
    </main>
  );
}
