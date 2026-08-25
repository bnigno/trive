"use client";

import { useActionState } from "react";

import { ConfirmButton } from "@/components/ui/confirm-button";
import { Input, SubmitButton } from "@/components/ui/form";
import {
  approveVersionAction,
  rejectVersionAction,
  type ApprovalState,
} from "./actions";

const summaryClasses =
  "cursor-pointer list-none rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 [&::-webkit-details-marker]:hidden";

/** Aprovar (com confirmação) + Rejeitar (form inline com motivo obrigatório). */
export function RowActions({
  versionId,
  sku,
  priceLabel,
}: {
  versionId: string;
  sku: string;
  priceLabel: string;
}) {
  const [approveState, approveDispatch] = useActionState<
    ApprovalState,
    FormData
  >(approveVersionAction, {});
  const [rejectState, rejectDispatch] = useActionState<ApprovalState, FormData>(
    rejectVersionAction,
    {},
  );
  const error = approveState.error ?? rejectState.error;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <form action={approveDispatch}>
          <input type="hidden" name="versionId" value={versionId} />
          <ConfirmButton
            size="sm"
            variant="primary"
            confirmMessage={`Aprovar e ativar o preço ${priceLabel} para ${sku}? Ele passa a valer imediatamente.`}
          >
            Aprovar
          </ConfirmButton>
        </form>
        <details>
          <summary className={summaryClasses}>Rejeitar</summary>
          <form action={rejectDispatch} className="mt-2 flex items-center gap-2">
            <input type="hidden" name="versionId" value={versionId} />
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
