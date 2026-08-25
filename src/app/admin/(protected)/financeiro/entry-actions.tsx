"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { ConfirmButton } from "@/components/ui/confirm-button";
import { Button, Input } from "@/components/ui/form";
import {
  cancelEntryAction,
  settleEntryAction,
  type FormState,
} from "./actions";

const initialState: FormState = {};

function SettleButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending ? "Liquidando…" : "Liquidar"}
    </Button>
  );
}

function Feedback({ state }: { state: FormState }) {
  if (state.error) {
    return (
      <p role="alert" className="text-xs text-red-600 dark:text-red-400">
        {state.error}
      </p>
    );
  }
  if (state.success) {
    return (
      <p role="status" className="text-xs text-emerald-600 dark:text-emerald-400">
        {state.success}
      </p>
    );
  }
  return null;
}

/**
 * Ações de uma linha pendente: Liquidar (marca como pago/recebido) e
 * Cancelar (exige motivo e confirmação).
 */
export function EntryActions({ entryId }: { entryId: string }) {
  const [settleState, settleFormAction] = useActionState(
    settleEntryAction,
    initialState,
  );
  const [cancelState, cancelFormAction] = useActionState(
    cancelEntryAction,
    initialState,
  );

  return (
    <div className="flex min-w-56 flex-col gap-2">
      <form action={settleFormAction}>
        <input type="hidden" name="entryId" value={entryId} />
        <SettleButton />
      </form>

      <form action={cancelFormAction} className="flex items-center gap-2">
        <input type="hidden" name="entryId" value={entryId} />
        <Input
          name="reason"
          placeholder="Motivo do cancelamento"
          aria-label="Motivo do cancelamento"
          className="max-w-44 px-2 py-1.5 text-xs"
        />
        <ConfirmButton
          size="sm"
          confirmMessage="Cancelar este lançamento? Ele sai das contas do mês e a ação não pode ser desfeita."
        >
          Cancelar
        </ConfirmButton>
      </form>

      <Feedback state={settleState} />
      <Feedback state={cancelState} />
    </div>
  );
}
