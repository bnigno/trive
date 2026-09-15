"use client";

// Cadastro do motoboy: nome + WhatsApp. Só apresentação; a normalização do
// telefone e a regra de duplicidade ficam no service.
import { useActionState } from "react";

import { Field, FormError, FormSuccess, Input, SubmitButton } from "@/components/ui/form";

import { createCourierAction, updateCourierAction, type FormState } from "./actions";

const INITIAL_STATE: FormState = {};

export function CourierCreateForm() {
  const [state, formAction] = useActionState(createCourierAction, INITIAL_STATE);
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Nome">
          <Input name="name" placeholder="Ex.: Carlos" required maxLength={60} />
        </Field>
        <Field label="WhatsApp" hint="Com DDD. É para onde vai o link de cada saída.">
          <Input name="phone" type="tel" inputMode="tel" placeholder="(91) 98888-7777" required />
        </Field>
      </div>
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      <div>
        <SubmitButton pendingLabel="Cadastrando…">Cadastrar motoboy</SubmitButton>
      </div>
    </form>
  );
}

export function CourierEditForm({ courierId, name, phone }: { courierId: string; name: string; phone: string }) {
  const [state, formAction] = useActionState(updateCourierAction, INITIAL_STATE);
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="courierId" value={courierId} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Nome">
          <Input name="name" defaultValue={name} required maxLength={60} />
        </Field>
        <Field label="WhatsApp">
          <Input name="phone" type="tel" inputMode="tel" defaultValue={phone} required />
        </Field>
      </div>
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      <div>
        <SubmitButton size="sm" variant="outline" pendingLabel="Salvando…">
          Salvar
        </SubmitButton>
      </div>
    </form>
  );
}
