"use client";

import { useActionState } from "react";

import { FormError, FormSuccess, SubmitButton } from "@/components/ui/form";

import { generateEditionCardsAction, type CardsFormState } from "./actions";

const INITIAL: CardsFormState = {};

/** "Gerar cartões" (primeira vez) ou "Gerar de novo" (nota escrita depois). */
export function CardsForm({ orderId, generated }: { orderId: string; generated: boolean }) {
  const [state, action] = useActionState(generateEditionCardsAction, INITIAL);
  return (
    <form action={action} className="flex flex-col gap-2 print:hidden">
      <input type="hidden" name="orderId" value={orderId} />
      <div>
        <SubmitButton pendingLabel="Desenhando…" variant={generated ? "outline" : "primary"}>
          {generated ? "Gerar de novo" : "Gerar cartões"}
        </SubmitButton>
      </div>
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
    </form>
  );
}
