"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { ConfirmButton } from "@/components/ui/confirm-button";
import { Button } from "@/components/ui/form";
import {
  deactivateSupplierAction,
  settleSupplierEntryAction,
  type FormState,
} from "../actions";

const initialState: FormState = {};

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
      <p
        role="status"
        className="text-xs text-emerald-600 dark:text-emerald-400"
      >
        {state.success}
      </p>
    );
  }
  return null;
}

/** Desativa o fornecedor (soft-delete) com confirmação. */
export function DeactivateSupplierForm({ supplierId }: { supplierId: string }) {
  const [state, formAction] = useActionState(
    deactivateSupplierAction,
    initialState,
  );

  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="supplierId" value={supplierId} />
      <ConfirmButton
        size="sm"
        variant="outline"
        confirmMessage="Desativar este fornecedor? Ele some das listas, mas o histórico de compras e contas continua guardado."
      >
        Desativar fornecedor
      </ConfirmButton>
      <Feedback state={state} />
    </form>
  );
}

function SettleButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending ? "Liquidando…" : "Liquidar"}
    </Button>
  );
}

/** Marca uma conta a pagar pendente como paga, direto do card do fornecedor. */
export function SettleEntryForm({
  supplierId,
  entryId,
}: {
  supplierId: string;
  entryId: string;
}) {
  const [state, formAction] = useActionState(
    settleSupplierEntryAction,
    initialState,
  );

  return (
    <div className="flex flex-col gap-1">
      <form action={formAction}>
        <input type="hidden" name="supplierId" value={supplierId} />
        <input type="hidden" name="entryId" value={entryId} />
        <SettleButton />
      </form>
      <Feedback state={state} />
    </div>
  );
}
