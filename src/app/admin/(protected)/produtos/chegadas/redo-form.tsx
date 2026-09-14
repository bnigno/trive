"use client";
// "Refazer" uma chegada: o rascunho antigo é arquivado e a montagem volta
// para a fila. Confirmação porque edição manual na ficha antiga fica
// arquivada com ela (nada é apagado, mas some da lista).
import { useActionState } from "react";

import { ConfirmButton } from "@/components/ui/confirm-button";
import { redoAtelierIntakeAction, type RedoFormState } from "./actions";

export function RedoIntakeForm({ intakeId, hasProduct }: { intakeId: string; hasProduct: boolean }) {
  const [state, formAction, pending] = useActionState<RedoFormState, FormData>(redoAtelierIntakeAction, {});
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="intakeId" value={intakeId} />
      <ConfirmButton
        size="sm"
        variant="outline"
        disabled={pending}
        confirmMessage={
          hasProduct
            ? "Refazer esta chegada? O rascunho atual é ARQUIVADO (o que você editou nele fica arquivado junto) e a conta a pagar pendente é cancelada. A peça nasce de novo com as mesmas fotos e o mesmo recado."
            : "Refazer esta chegada com as mesmas fotos e o mesmo recado?"
        }
      >
        {pending ? "Refazendo…" : "Refazer"}
      </ConfirmButton>
      {state.error ? <span className="text-xs text-red-700 dark:text-red-300">{state.error}</span> : null}
      {state.success ? <span className="text-xs text-emerald-700 dark:text-emerald-300">{state.success}</span> : null}
    </form>
  );
}
