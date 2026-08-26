"use client";

import { useActionState } from "react";

import {
  Field,
  FormError,
  Input,
  SubmitButton,
} from "@/components/ui/form";
import { setMyPasswordAction, type FormState } from "./actions";

const initialState: FormState = {};

export function NewPasswordForm({ first }: { first: boolean }) {
  const [state, formAction] = useActionState(setMyPasswordAction, initialState);

  return (
    <form action={formAction} className="flex max-w-sm flex-col gap-4">
      <Field
        label="Nova senha"
        hint="Pelo menos 8 caracteres. Evite datas de aniversário e o nome da loja."
      >
        <Input
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
        />
      </Field>

      <Field label="Repita a nova senha">
        <Input
          name="confirmation"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
        />
      </Field>

      <FormError message={state.error} />

      <div>
        <SubmitButton pendingLabel="Salvando…">
          {first ? "Definir senha" : "Salvar nova senha"}
        </SubmitButton>
      </div>
    </form>
  );
}
