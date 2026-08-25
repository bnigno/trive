"use client";

import { useActionState } from "react";
import {
  Field,
  FormError,
  FormSuccess,
  Input,
  SubmitButton,
} from "@/components/ui/form";
import {
  createShippingRateAction,
  updateShippingRateAction,
  type FormState,
} from "./actions";

const INITIAL_STATE: FormState = {};

/** Valores já formatados para preencher os inputs (feito no server). */
export type RateFormDefaults = {
  name: string;
  /** '01000-000' */
  cepStart: string;
  cepEnd: string;
  /** '0,3' (kg) */
  weightMinKg: string;
  weightMaxKg: string;
  /** '24,90' */
  price: string;
  deliveryDaysMin: number;
  deliveryDaysMax: number;
};

function RateFields({ defaults }: { defaults: RateFormDefaults | null }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Field
        label="Nome da faixa"
        hint="Como você identifica esta faixa. Ex.: Brasil inteiro, Capital SP."
        className="sm:col-span-2"
      >
        <Input
          name="name"
          required
          maxLength={120}
          defaultValue={defaults?.name ?? ""}
          placeholder="Brasil inteiro"
        />
      </Field>
      <Field label="CEP inicial" hint="Começo da faixa de CEP atendida.">
        <Input
          name="cepStart"
          required
          inputMode="numeric"
          defaultValue={defaults?.cepStart ?? "00000-000"}
          placeholder="00000-000"
        />
      </Field>
      <Field label="CEP final" hint="Fim da faixa de CEP atendida.">
        <Input
          name="cepEnd"
          required
          inputMode="numeric"
          defaultValue={defaults?.cepEnd ?? "99999-999"}
          placeholder="99999-999"
        />
      </Field>
      <Field
        label="Peso mínimo (kg)"
        hint="A partir de quantos kg esta faixa vale. Use 0 para qualquer peso."
      >
        <Input
          name="weightMinKg"
          required
          inputMode="decimal"
          defaultValue={defaults?.weightMinKg ?? "0"}
          placeholder="0"
        />
      </Field>
      <Field
        label="Peso máximo (kg)"
        hint="Até quantos kg esta faixa vale. Ex.: 30."
      >
        <Input
          name="weightMaxKg"
          required
          inputMode="decimal"
          defaultValue={defaults?.weightMaxKg ?? "30"}
          placeholder="30"
        />
      </Field>
      <Field
        label="Preço do frete (R$)"
        hint="Quanto o cliente paga. Ex.: 24,90."
      >
        <Input
          name="price"
          required
          inputMode="decimal"
          defaultValue={defaults?.price ?? ""}
          placeholder="24,90"
        />
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Prazo mínimo (dias)">
          <Input
            name="deliveryDaysMin"
            type="number"
            min={0}
            step={1}
            required
            defaultValue={
              defaults ? String(defaults.deliveryDaysMin) : "3"
            }
          />
        </Field>
        <Field label="Prazo máximo (dias)">
          <Input
            name="deliveryDaysMax"
            type="number"
            min={0}
            step={1}
            required
            defaultValue={
              defaults ? String(defaults.deliveryDaysMax) : "10"
            }
          />
        </Field>
      </div>
    </div>
  );
}

export function ShippingRateCreateForm() {
  const [state, formAction] = useActionState(
    createShippingRateAction,
    INITIAL_STATE,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <RateFields defaults={null} />
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      <div>
        <SubmitButton pendingLabel="Criando…">Criar faixa de frete</SubmitButton>
      </div>
    </form>
  );
}

export function ShippingRateEditForm({
  rateId,
  isActive,
  defaults,
}: {
  rateId: string;
  isActive: boolean;
  defaults: RateFormDefaults;
}) {
  const [state, formAction] = useActionState(
    updateShippingRateAction,
    INITIAL_STATE,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="id" value={rateId} />
      <RateFields defaults={defaults} />

      <label className="flex items-start gap-2 text-sm text-zinc-700 dark:text-zinc-300">
        <input
          type="checkbox"
          name="isActive"
          defaultChecked={isActive}
          className="mt-0.5 h-4 w-4 rounded border-zinc-300 dark:border-zinc-700"
        />
        <span>
          Faixa ativa
          <span className="block text-xs text-zinc-500 dark:text-zinc-400">
            Desmarcada, a faixa deixa de aparecer nas cotações da loja.
          </span>
        </span>
      </label>

      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      <div>
        <SubmitButton pendingLabel="Salvando…">Salvar alterações</SubmitButton>
      </div>
    </form>
  );
}
