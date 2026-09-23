"use client";

import { useActionState } from "react";

import { SubmitButton } from "@/components/ui/form";
import { deleteProductAction, type FormState } from "../../actions";

const initialState: FormState = {};

/** O botão que faz o estrago. O aviso inteiro está na tela ao redor. */
export function DeleteProductForm({
  productId,
  productName,
}: {
  productId: string;
  productName: string;
}) {
  const [state, formAction] = useActionState(deleteProductAction, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-1">
      <input type="hidden" name="productId" value={productId} />
      <SubmitButton variant="danger" size="sm" pendingLabel="Excluindo…">
        Excluir «{productName}»
      </SubmitButton>
      {state.error ? (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
