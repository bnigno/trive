"use client";

// Os dois gestos da rota: "Saiu" (confirmação, porque avisa a cliente na
// hora) e "Reagendar" (select com as janelas das faixas de motoboy, hoje e
// nos próximos dias). Sem regra aqui — tudo vem das actions/services.
import { useActionState } from "react";

import { ConfirmButton } from "@/components/ui/confirm-button";
import { FormError, FormSuccess, Select, SubmitButton } from "@/components/ui/form";

import { dispatchOrderAction, rescheduleWindowAction, type FormState } from "./actions";

const initialState: FormState = {};

export function DispatchForm({ orderId, customerName, compact = false }: { orderId: string; customerName: string; compact?: boolean }) {
  const [state, formAction] = useActionState(dispatchOrderAction, initialState);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="orderId" value={orderId} />
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      <ConfirmButton
        variant="primary"
        size={compact ? "sm" : "md"}
        confirmMessage={`O pedido de ${customerName} saiu com o motoboy? A cliente recebe "Saiu da maison" no WhatsApp agora.`}
      >
        Saiu
      </ConfirmButton>
    </form>
  );
}

export interface RescheduleChoice {
  /** "dayKey|start|end|cutoff" */
  value: string;
  label: string;
}

export function RescheduleForm({ orderId, choices }: { orderId: string; choices: RescheduleChoice[] }) {
  const [state, formAction] = useActionState(rescheduleWindowAction, initialState);
  if (choices.length === 0) {
    return <p className="text-xs text-zinc-500 dark:text-zinc-400">Sem janelas de motoboy ativas em Frete para reagendar.</p>;
  }
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="orderId" value={orderId} />
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400">
          Nova janela
          <Select name="choice" defaultValue={choices[0].value}>
            {choices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </Select>
        </label>
        <SubmitButton size="sm" variant="outline" pendingLabel="Reagendando…">
          Reagendar
        </SubmitButton>
      </div>
    </form>
  );
}
