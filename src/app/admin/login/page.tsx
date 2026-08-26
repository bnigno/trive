import type { Metadata } from "next";
import { LoginForm, type LoginNotice } from "./login-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Entrar",
};

// `motivo` vem da URL: só vira texto na tela depois de bater com esta lista —
// nunca é ecoado cru.
const NOTICE_BY_REASON: Record<string, LoginNotice> = {
  "nao-autorizado": {
    tone: "aviso",
    text: "Sua conta não tem acesso ao painel. Fale com o responsável pela loja.",
  },
  inativo: {
    tone: "aviso",
    text: "Sua conta está desativada. Fale com o responsável pela loja.",
  },
  "link-invalido": {
    tone: "aviso",
    text: "Este link de acesso expirou ou já foi usado. Peça um novo em “Esqueci minha senha”.",
  },
  "senha-alterada": {
    tone: "ok",
    text: "Senha alterada! Entre com o seu e-mail e a senha nova.",
  },
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
