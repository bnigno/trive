"use client";

import { useActionState } from "react";

import { FormError, FormSuccess, SubmitButton } from "@/components/ui/form";

import { generateEditionCardsAction, type CardsFormState } from "./actions";

const INITIAL: CardsFormState = {};

/**
 * "Gerar cartões" (primeira vez), "Gerar de novo" (nota escrita depois) — em
 * destaque quando o cartão ficou velho.
 */
export function CardsForm({ orderId, generated, stale }: { orderId: string; generated: boolean; stale: boolean }) {
  const [state, action] = useActionState(generateEditionCardsAction, INITIAL);
  return (
    <form action={action} className="flex flex-col gap-2 print:hidden">
      <input type="hidden" name="orderId" value={orderId} />
      <div>
        <SubmitButton pendingLabel="Desenhando…" variant={generated && !stale ? "outline" : "primary"}>
          {generated ? "Gerar de novo" : "Gerar cartões"}
        </SubmitButton>
      </div>
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
    </form>
  );
}
