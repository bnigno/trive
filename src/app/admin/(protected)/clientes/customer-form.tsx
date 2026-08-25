"use client";

import { useActionState } from "react";

import {
  Field,
  FormError,
  FormSuccess,
  Input,
  SubmitButton,
  TextArea,
} from "@/components/ui/form";
import {
  createCustomerAction,
  updateCustomerAction,
  type FormState,
} from "./actions";

const initialState: FormState = {};

export type CustomerFormInitial = {
  id: string;
  fullName: string;
  email: string;
  phone: string;
  document: string;
  notes: string;
  marketingOptIn: boolean;
};

/**
 * Formulário de cliente. Sem `initial` cria um cliente novo (com bloco de
 * endereço); com `initial` edita o cadastro existente.
 */
export function CustomerForm({ initial }: { initial?: CustomerFormInitial }) {
  const [state, formAction] = useActionState(
    initial ? updateCustomerAction : createCustomerAction,
    initialState,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {initial ? (
        <input type="hidden" name="customerId" value={initial.id} />
      ) : null}

      <Field label="Nome completo">
        <Input
          name="fullName"
          required
          defaultValue={initial?.fullName}
          placeholder="Ex.: Maria da Silva"
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="E-mail">
          <Input
            name="email"
            type="email"
            defaultValue={initial?.email}
            placeholder="cliente@email.com"
          />
        </Field>
        <Field label="Telefone" hint="Com DDD, ex: 11 99999-8888">
          <Input
            name="phone"
            defaultValue={initial?.phone}
            placeholder="11 99999-8888"
          />
        </Field>
      </div>

      <Field
        label="CPF ou CNPJ (opcional)"
        hint="Usado em notas e cobranças. Pode deixar em branco."
      >
        <Input
          name="document"
          defaultValue={initial?.document}
          placeholder="000.000.000-00"
        />
      </Field>

      <Field label="Observações">
        <TextArea
          name="notes"
          defaultValue={initial?.notes}
          placeholder="Anotações internas sobre o cliente (só sua equipe vê)"
        />
      </Field>

      <label className="flex items-start gap-2.5 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-sm dark:border-zinc-800 dark:bg-zinc-800/40">
        <input
          type="checkbox"
          name="marketingOptIn"
          defaultChecked={initial?.marketingOptIn ?? false}
          className="mt-0.5 h-4 w-4 accent-indigo-600"
        />
        <span>
          <span className="font-medium text-zinc-800 dark:text-zinc-200">
            Aceita receber mensagens no WhatsApp
          </span>
          <span className="mt-0.5 block text-xs text-zinc-500 dark:text-zinc-400">
            Marque apenas se o cliente autorizou — pela LGPD, mensagens de
            oferta exigem consentimento, que ele pode retirar quando quiser.
          </span>
        </span>
      </label>

      {!initial ? (
        <fieldset className="mt-2 flex flex-col gap-4 rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
          <legend className="px-1 text-sm font-semibold text-zinc-800 dark:text-zinc-200">
            Endereço (opcional)
          </legend>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="CEP">
              <Input name="postalCode" placeholder="01310-100" />
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
        </fieldset>
      ) : null}

      <FormError message={state.error} />
      <FormSuccess message={state.success} />

      <div>
        <SubmitButton>
          {initial ? "Salvar alterações" : "Cadastrar cliente"}
        </SubmitButton>
      </div>
    </form>
  );
}
