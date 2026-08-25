"use client";

import { useActionState } from "react";

import { ConfirmButton } from "@/components/ui/confirm-button";
import { Input, SubmitButton } from "@/components/ui/form";
import {
  approveBatchAction,
  rejectBatchAction,
  type ApprovalState,
} from "./actions";

const summaryClasses =
  "cursor-pointer list-none rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 [&::-webkit-details-marker]:hidden";

/** Aprovar/Rejeitar TODAS as versões pendentes de um lote de recálculo. */
export function BatchActions({
  batchId,
  count,
}: {
  batchId: string;
  count: number;
}) {
  const [approveState, approveDispatch] = useActionState<
    ApprovalState,
    FormData
  >(approveBatchAction, {});
  const [rejectState, rejectDispatch] = useActionState<ApprovalState, FormData>(
    rejectBatchAction,
    {},
  );
  const error = approveState.error ?? rejectState.error;

  const itens = count === 1 ? "1 preço será ativado" : `${count} preços serão ativados`;

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-start gap-2">
        <form action={approveDispatch}>
          <input type="hidden" name="batchId" value={batchId} />
          <ConfirmButton
            size="sm"
            variant="primary"
            confirmMessage={`Aprovar o lote inteiro? ${itens} de uma vez.`}
          >
            Aprovar lote
          </ConfirmButton>
        </form>
        <details>
          <summary className={summaryClasses}>Rejeitar lote</summary>
          <form action={rejectDispatch} className="mt-2 flex items-center gap-2">
            <input type="hidden" name="batchId" value={batchId} />
            <Input
              name="motivo"
              placeholder="Motivo da rejeição"
              required
              className="w-44 text-xs"
            />
            <SubmitButton size="sm" variant="danger" pendingLabel="Rejeitando…">
              Confirmar
            </SubmitButton>
          </form>
        </details>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}
