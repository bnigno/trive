"use client";

import { useActionState } from "react";

import { ConfirmButton } from "@/components/ui/confirm-button";
import { restoreProductAction, type FormState } from "./actions";

const initialState: FormState = {};

/** Traz de volta uma peça excluída — como rascunho e sem as fotos. */
export function RestoreProductForm({
  productId,
  productName,
}: {
  productId: string;
  productName: string;
}) {
  const [state, formAction] = useActionState(restoreProductAction, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-1">
      <input type="hidden" name="productId" value={productId} />
      <ConfirmButton
        size="sm"
        variant="outline"
        confirmMessage={`Restaurar «${productName}»? Ela volta como rascunho e sem as fotos — você precisa subir as fotos de novo antes de ativar.`}
      >
        Restaurar
      </ConfirmButton>
      {state.error ? (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
      {state.success ? (
        <p role="status" className="text-xs text-emerald-600 dark:text-emerald-400">
          {state.success}
        </p>
      ) : null}
    </form>
  );
}
