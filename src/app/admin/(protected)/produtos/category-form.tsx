"use client";

import { useActionState } from "react";
import {
  FormError,
  FormSuccess,
  Input,
  SubmitButton,
} from "@/components/ui/form";
import { createCategoryAction, type FormState } from "./actions";

const initialState: FormState = {};

export function CategoryForm() {
  const [state, formAction] = useActionState(createCategoryAction, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Input
          name="name"
          placeholder="Nome da nova categoria"
          aria-label="Nome da nova categoria"
          required
        />
        <SubmitButton pendingLabel="Criando…" className="shrink-0">
          Criar categoria
        </SubmitButton>
      </div>
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
    </form>
  );
}
