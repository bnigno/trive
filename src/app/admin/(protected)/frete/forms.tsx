"use client";

import { useActionState, useState } from "react";
import {
  Field,
  FormError,
  FormSuccess,
  Input,
  Select,
  SubmitButton,
} from "@/components/ui/form";
import {
  createShippingRateAction,
  updateCorreiosAutoAction,
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
  kind: "correios" | "motoboy";
  /** Até 4 janelas do motoboy: 'HH:MM'. */
  deliveryWindows: { start: string; end: string; cutoff: string }[];
};

const WINDOW_SLOTS = 4;
const EMPTY_WINDOW = { start: "", end: "", cutoff: "" };

function RateFields({ defaults }: { defaults: RateFormDefaults | null }) {
  const [kind, setKind] = useState<"correios" | "motoboy">(defaults?.kind ?? "correios");
  const windows = [...(defaults?.deliveryWindows ?? []), ...Array.from({ length: WINDOW_SLOTS }, () => EMPTY_WINDOW)].slice(0, WINDOW_SLOTS);
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Field
        label="Tipo"
        hint="Correios/transportadora entrega em dias úteis; motoboy entrega no mesmo dia em janelas de horário (com hora-limite para pagar)."
        className="sm:col-span-2"
      >
        <Select name="kind" value={kind} onChange={(event) => setKind(event.target.value === "motoboy" ? "motoboy" : "correios")}>
          <option value="correios">Correios / transportadora (prazo em dias)</option>
          <option value="motoboy">Motoboy (janelas de horário, no mesmo dia)</option>
        </Select>
      </Field>
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
      {kind === "correios" ? (
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
      ) : (
        <div className="sm:col-span-2 flex flex-col gap-2">
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Janelas de entrega</p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Até 4 janelas. “Pague até” é a hora-limite do pagamento para a peça sair na janela de HOJE; depois disso a cliente vê “amanhã”. Horários no relógio de Belém/Brasília.
          </p>
          <div className="grid gap-2">
            {windows.map((window, index) => (
              <div key={index} className="grid grid-cols-3 gap-2">
                <Field label={index === 0 ? "Das" : ""}>
                  <Input name={`window_${index}_start`} type="time" step={900} defaultValue={window.start} placeholder="19:00" aria-label={`Janela ${index + 1}: início`} />
                </Field>
                <Field label={index === 0 ? "Às" : ""}>
                  <Input name={`window_${index}_end`} type="time" step={900} defaultValue={window.end} placeholder="21:00" aria-label={`Janela ${index + 1}: fim`} />
                </Field>
                <Field label={index === 0 ? "Pague até" : ""}>
                  <Input name={`window_${index}_cutoff`} type="time" step={900} defaultValue={window.cutoff} placeholder="13:00" aria-label={`Janela ${index + 1}: pague até`} />
                </Field>
              </div>
            ))}
          </div>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">Linha em branco é ignorada. Ex.: 9:00–12:00 pague até 8:00 · 16:00–19:00 pague até 13:00 · 19:00–21:00 pague até 13:00.</p>
        </div>
      )}
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

// ---------------------------------------------------------------------------
// Correios automático (SuperFrete)
// ---------------------------------------------------------------------------

export type CorreiosAutoDefaults = {
  enabled: boolean;
  /** '66045-335' ou ''. */
  storeCep: string;
  /** '3,00'. */
  surcharge: string;
};

export function CorreiosAutoForm({ defaults }: { defaults: CorreiosAutoDefaults }) {
  const [state, formAction] = useActionState(updateCorreiosAutoAction, INITIAL_STATE);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="CEP de origem" hint="De onde os pacotes saem (o CEP da loja). Ex.: 66045-335.">
          <Input name="storeCep" defaultValue={defaults.storeCep} inputMode="numeric" placeholder="00000-000" />
        </Field>
        <Field
          label="Acréscimo por pedido (R$)"
          hint="Embalagem: somado ao preço dos Correios e mostrado como um valor só para a cliente. Padrão: 3,00."
        >
          <Input name="correiosSurcharge" defaultValue={defaults.surcharge} inputMode="decimal" placeholder="3,00" />
        </Field>
      </div>

      <label className="flex items-start gap-2 text-sm text-zinc-700 dark:text-zinc-300">
        <input
          type="checkbox"
          name="correiosAutoEnabled"
          defaultChecked={defaults.enabled}
          className="mt-0.5 h-4 w-4 rounded border-zinc-300 dark:border-zinc-700"
        />
        <span>
          Cotar PAC e SEDEX automaticamente fora da área do motoboy
          <span className="block text-xs text-zinc-500 dark:text-zinc-400">
            Com o toggle ligado, o token da SuperFrete no site e o CEP de origem preenchido, a sacola e a Lia mostram PAC e SEDEX com valor e prazo.
          </span>
        </span>
      </label>

      <FormError message={state.error} />
      <FormSuccess message={state.success} />

      <div>
        <SubmitButton pendingLabel="Salvando…">Salvar Correios automático</SubmitButton>
      </div>
    </form>
  );
}
