"use client";

import { useActionState, useRef } from "react";

import { CEP_AUTOFILL_MESSAGES, useCepAutofill } from "@/components/forms/use-cep-autofill";

import {
  Field,
  FormError,
  FormSuccess,
  Input,
  SubmitButton,
} from "@/components/ui/form";
import { addAddressAction, lookupCepAction, type FormState } from "../actions";

const initialState: FormState = {};

export function AddressForm({ customerId }: { customerId: string }) {
  const [state, formAction] = useActionState(addAddressAction, initialState);
  const formRef = useRef<HTMLFormElement>(null);
  const cepAutofill = useCepAutofill(formRef, (cep) => lookupCepAction({ cep }));

  return (
    <form ref={formRef} action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="customerId" value={customerId} />

      <Field
        label="Apelido do endereço"
        hint="Ex.: Casa, Trabalho — ajuda a identificar na hora do envio."
      >
        <Input name="addressLabel" placeholder="Casa" />
      </Field>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field
          label="CEP"
          hint={cepAutofill.status === "idle" ? "Preenche o endereço sozinho." : CEP_AUTOFILL_MESSAGES[cepAutofill.status]}
        >
          <Input
            name="postalCode"
            placeholder="01310-100"
            inputMode="numeric"
            onChange={(event) => cepAutofill.onCepChange(event.target.value)}
          />
        </Field>
        <Field label="Rua" className="sm:col-span-2">
          <Input name="street" placeholder="Av. Paulista" />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Número">
          <Input name="number" placeholder="1000" />
        </Field>
        <Field label="Complemento" className="sm:col-span-2">
          <Input name="complement" placeholder="Apto 42, bloco B" />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Bairro">
          <Input name="district" placeholder="Bela Vista" />
        </Field>
        <Field label="Cidade">
          <Input name="city" placeholder="São Paulo" />
        </Field>
        <Field label="UF" hint="2 letras, ex.: SP">
          <Input name="state" maxLength={2} placeholder="SP" />
        </Field>
      </div>

      <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
        <input
          type="checkbox"
          name="isDefault"
          className="h-4 w-4 accent-indigo-600"
        />
        Usar como endereço padrão de entrega
      </label>

      <FormError message={state.error} />
      <FormSuccess message={state.success} />

      <div>
        <SubmitButton pendingLabel="Adicionando…">
          Adicionar endereço
        </SubmitButton>
      </div>
    </form>
  );
}
