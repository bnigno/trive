"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { ConfirmButton } from "@/components/ui/confirm-button";
import { FormError } from "@/components/ui/form";
import { recalculateAllAction, type RecalcState } from "./actions";

const CONFIRM_MESSAGE =
  "Recalcular todos os preços agora?\n\n" +
  "Cada variante com preço ativo será recalculada com os custos e taxas " +
  "atuais. Mudanças críticas (queda de preço, variação acima do limite ou " +
  "margem abaixo do mínimo) irão para aprovação antes de valer; as demais " +
  "entram em vigor na hora.";

function RecalcSubmit() {
  const { pending } = useFormStatus();
  return (
    <ConfirmButton
      confirmMessage={CONFIRM_MESSAGE}
      variant="primary"
      disabled={pending}
    >
      {pending ? "Recalculando…" : "Recalcular todos"}
    </ConfirmButton>
  );
}

export function RecalcButton() {
  const [state, formAction] = useActionState<RecalcState, FormData>(
    recalculateAllAction,
    {},
  );

  return (
    <div className="flex flex-col items-end gap-2">
      <form action={formAction}>
        <RecalcSubmit />
      </form>
      <FormError message={state.error} />
    </div>
  );
}
