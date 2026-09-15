"use client";

// Os dois gestos da rota: "Saiu" (confirmação, porque avisa a cliente na
// hora) e "Reagendar" (select com as janelas das faixas de motoboy, hoje e
// nos próximos dias). Sem regra aqui — tudo vem das actions/services.
import Link from "next/link";
import { useActionState, useEffect, useState } from "react";

import { ConfirmButton } from "@/components/ui/confirm-button";
import { FormError, FormSuccess, Select, SubmitButton } from "@/components/ui/form";

import { completeDispatchedOrderAction, createDeliveryRunAction, dispatchOrderAction, rescheduleWindowAction, type FormState } from "./actions";
import { MOUNT_RUN_FORM_ID } from "./mount-run";

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
        confirmMessage={`O pedido de ${customerName} saiu com o motoboy? A cliente recebe "Saiu da TRIVÉ" no WhatsApp agora.`}
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

export function DeliveredForm({ orderId }: { orderId: string }) {
  const [state, formAction] = useActionState(completeDispatchedOrderAction, initialState);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="orderId" value={orderId} />
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      <SubmitButton pendingLabel="Marcando…">Entregue — o motoboy voltou</SubmitButton>
    </form>
  );
}

/** Os checkboxes dos cards apontam para este form pelo atributo `form`. */
function countSelected(): number {
  return document.querySelectorAll<HTMLInputElement>(`input[form="${MOUNT_RUN_FORM_ID}"][name="orderIds"]:checked`).length;
}

/**
 * "Montar saída": o motoboy e a contagem dos pedidos marcados nos cards
 * (checkboxes espalhados pela página, ligados a este form pelo atributo
 * `form` — sem aninhar forms). O envio dá o "Saiu" em todos e manda o link.
 */
export function MountRunForm({ couriers }: { couriers: { id: string; name: string }[] }) {
  const [state, formAction] = useActionState(createDeliveryRunAction, initialState);
  const [selected, setSelected] = useState(0);
  useEffect(() => {
    const update = () => setSelected(countSelected());
    update();
    document.addEventListener("change", update);
    return () => document.removeEventListener("change", update);
  }, []);

  if (couriers.length === 0) {
    return (
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Para uma saída com GPS,{" "}
        <Link href="/admin/pedidos/motoboys" className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
          cadastre um motoboy
        </Link>{" "}
        (nome + WhatsApp). Sem isso, o &ldquo;Saiu&rdquo; de cada pedido continua funcionando como antes.
      </p>
    );
  }
  const label = selected === 1 ? "1 pedido marcado" : `${selected} pedidos marcados`;
  return (
    <form id={MOUNT_RUN_FORM_ID} action={formAction} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-48 flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400">
          Motoboy
          <Select name="courierId" defaultValue={couriers[0].id}>
            {couriers.map((courier) => (
              <option key={courier.id} value={courier.id}>
                {courier.name}
              </option>
            ))}
          </Select>
        </label>
        <ConfirmButton
          variant="primary"
          disabled={selected === 0}
          confirmMessage={`Montar a saída com ${label}? Cada cliente recebe "Saiu da TRIVÉ" no WhatsApp agora, e o motoboy recebe o link das paradas.`}
        >
          Montar saída · {label}
        </ConfirmButton>
        <Link href="/admin/pedidos/motoboys" className="text-xs text-zinc-500 hover:underline dark:text-zinc-400">
          motoboys
        </Link>
      </div>
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
    </form>
  );
}
