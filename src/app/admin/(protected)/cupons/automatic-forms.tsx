"use client";

import { useActionState } from "react";
import { Field, FormError, FormSuccess, Input, SubmitButton } from "@/components/ui/form";
import { saveLateDeliverySettingsAction, saveLookCouponSettingsAction, type FormState } from "./actions";

const INITIAL_STATE: FormState = {};

export type LateDeliveryFormDefaults = {
  enabled: boolean;
  graceMinutes: number;
  percent: number;
  days: number;
};

export function LateDeliverySettingsForm({ defaults }: { defaults: LateDeliveryFormDefaults }) {
  const [state, formAction] = useActionState(saveLateDeliverySettingsAction, INITIAL_STATE);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
        <input
          type="checkbox"
          name="enabled"
          defaultChecked={defaults.enabled}
          className="h-4 w-4 rounded border-zinc-300 text-indigo-600 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-900"
        />
        <span>
          Pedir desculpas com cupom quando o motoboy atrasar
          <span className="block text-xs text-zinc-500 dark:text-zinc-400">
            Quando a entrega passa do fim da janela combinada mais a carência, a cliente recebe um cupom pessoal
            (código DESCULPA-…) e uma mensagem — só com opt-in e dentro da janela de envio.
          </span>
        </span>
      </label>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="Carência (minutos)" hint="Tolerância depois do fim da janela. Ex.: 30.">
          <Input name="graceMinutes" type="number" min={0} max={240} step={1} defaultValue={String(defaults.graceMinutes)} />
        </Field>
        <Field label="Desconto (%)" hint="Do cupom de desculpas. Ex.: 10.">
          <Input name="percent" type="number" min={1} max={50} step={1} defaultValue={String(defaults.percent)} />
        </Field>
        <Field label="Vale por (dias)" hint="Contados da entrega. Ex.: 30.">
          <Input name="days" type="number" min={1} max={180} step={1} defaultValue={String(defaults.days)} />
        </Field>
      </div>
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      <div>
        <SubmitButton pendingLabel="Salvando…">Salvar cupons automáticos</SubmitButton>
      </div>
    </form>
  );
}

export type LookCouponFormDefaults = { enabled: boolean; percent: number; days: number };

export function LookCouponSettingsForm({ defaults }: { defaults: LookCouponFormDefaults }) {
  const [state, formAction] = useActionState(saveLookCouponSettingsAction, INITIAL_STATE);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
        <input
          type="checkbox"
          name="enabled"
          defaultChecked={defaults.enabled}
          className="h-4 w-4 rounded border-zinc-300 text-indigo-600 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-900"
        />
        <span>
          Mimo pela foto do “Quem já vestiu”
          <span className="block text-xs text-zinc-500 dark:text-zinc-400">
            Quando a cliente manda a foto dela usando uma peça que comprou (pedido entregue), a Lia registra a foto e ela ganha um cupom
            pessoal — uma vez por peça, nunca por print do catálogo. O consentimento de aparecer na página continua livre.
          </span>
        </span>
      </label>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Desconto (%)" hint="Do mimo. Ex.: 10.">
          <Input name="percent" type="number" min={1} max={50} step={1} defaultValue={String(defaults.percent)} />
        </Field>
        <Field label="Vale por (dias)" hint="Contados da foto. Ex.: 60.">
          <Input name="days" type="number" min={1} max={180} step={1} defaultValue={String(defaults.days)} />
        </Field>
      </div>
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      <div>
        <SubmitButton pendingLabel="Salvando…">Salvar mimo pela foto</SubmitButton>
      </div>
    </form>
  );
}
