"use client";

import Link from "next/link";
import { useActionState } from "react";

import {
  Field,
  FormError,
  FormSuccess,
  Input,
  SubmitButton,
} from "@/components/ui/form";
import { requestPasswordResetAction, type FormState } from "./actions";

const initialState: FormState = {};

export function ForgotPasswordForm() {
  const [state, formAction] = useActionState(
    requestPasswordResetAction,
    initialState,
  );

  return (
    <form
      action={formAction}
      className="flex flex-col gap-4 rounded-lg border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
    >
      <Field
        label="E-mail"
        hint="O mesmo e-mail que você usa para entrar no painel."
      >
        <Input
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder="voce@email.com"
        />
      </Field>

      <FormError message={state.error} />
      <FormSuccess message={state.success} />

      <SubmitButton pendingLabel="Enviando…" className="mt-1 w-full">
        Enviar link de acesso
      </SubmitButton>

      <Link
        href="/admin/login"
        className="text-center text-sm text-indigo-600 hover:underline dark:text-indigo-400"
      >
        Voltar para o login
      </Link>
    </form>
  );
}
