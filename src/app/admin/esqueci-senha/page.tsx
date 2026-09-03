import type { Metadata } from "next";
import { ForgotPasswordForm } from "./forgot-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Esqueci minha senha",
};

// Página PÚBLICA de propósito (fica fora de (protected)): quem esqueceu a
// senha não consegue passar por guard nenhum.
export default function ForgotPasswordPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-semibold tracking-[0.25em] text-zinc-900 dark:text-zinc-100">
            TRIVÉ
          </h1>
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
            Recuperar acesso ao painel
          </p>
        </div>

        <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-300">
          Informe seu e-mail e enviaremos um link para você criar uma senha
          nova. O link vale por pouco tempo e só pode ser usado uma vez.
        </p>

        <ForgotPasswordForm />
      </div>
    </main>
  );
}
