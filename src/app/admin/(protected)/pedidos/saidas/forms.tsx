"use client";

// Os gestos da saída no painel. Só apresentação.
import { useActionState } from "react";

import { ConfirmButton } from "@/components/ui/confirm-button";
import { FormError, FormSuccess, SubmitButton } from "@/components/ui/form";

import { cancelRunAction, finishRunAction, resendCourierLinkAction, type FormState } from "./actions";

const initialState: FormState = {};

export function ResendLinkForm({ runId, courierName }: { runId: string; courierName: string }) {
  const [state, formAction] = useActionState(resendCourierLinkAction, initialState);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="runId" value={runId} />
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      <SubmitButton size="sm" variant="outline" pendingLabel="Enviando…">
        Reenviar o link para {courierName}
      </SubmitButton>
    </form>
  );
}

export function FinishRunForm({ runId, pending }: { runId: string; pending: number }) {
  const [state, formAction] = useActionState(finishRunAction, initialState);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="runId" value={runId} />
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      <SubmitButton size="sm" variant="outline" pendingLabel="Encerrando…" disabled={pending > 0}>
        Encerrar saída
      </SubmitButton>
    </form>
  );
}

export function CancelRunForm({ runId, pending }: { runId: string; pending: number }) {
  const [state, formAction] = useActionState(cancelRunAction, initialState);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="runId" value={runId} />
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      <ConfirmButton
        size="sm"
        confirmMessage={`Cancelar esta saída? ${pending > 0 ? `${pending} parada${pending > 1 ? "s" : ""} por entregar ${pending > 1 ? "ficam" : "fica"} cancelada${pending > 1 ? "s" : ""} e o link do motoboy para de funcionar. ` : ""}O "Saiu" dos pedidos não volta: cada um continua como saído.`}
      >
        Cancelar saída
      </ConfirmButton>
    </form>
  );
}
