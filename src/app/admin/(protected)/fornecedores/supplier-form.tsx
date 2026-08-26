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
  createSupplierAction,
  updateSupplierAction,
  type FormState,
} from "./actions";

const initialState: FormState = {};

export type SupplierFormInitial = {
  id: string;
  name: string;
  contactName: string;
  email: string;
  phone: string;
  document: string;
  pixKey: string;
  notes: string;
};

/**
 * Formulário de fornecedor. Sem `initial` cria um fornecedor novo; com
 * `initial` edita o cadastro existente.
 */
export function SupplierForm({ initial }: { initial?: SupplierFormInitial }) {
  const [state, formAction] = useActionState(
    initial ? updateSupplierAction : createSupplierAction,
    initialState,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {initial ? (
        <input type="hidden" name="supplierId" value={initial.id} />
      ) : null}

      <Field label="Nome do fornecedor">
        <Input
          name="name"
          required
          defaultValue={initial?.name}
          placeholder="Ex.: Ateliê Pedras do Sul"
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Pessoa de contato">
          <Input
            name="contactName"
            defaultValue={initial?.contactName}
            placeholder="Ex.: Carlos (vendas)"
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

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="E-mail">
          <Input
            name="email"
            type="email"
            defaultValue={initial?.email}
            placeholder="fornecedor@email.com"
          />
        </Field>
        <Field
          label="CPF ou CNPJ (opcional)"
          hint="Usado em notas e pagamentos. Pode deixar em branco."
        >
          <Input
            name="document"
            defaultValue={initial?.document}
            placeholder="00.000.000/0000-00"
          />
        </Field>
      </div>

      <Field
        label="Chave Pix (opcional)"
        hint="Chave para PAGAR este fornecedor — fica à mão na hora de quitar as compras."
      >
        <Input
          name="pixKey"
          defaultValue={initial?.pixKey}
          placeholder="CNPJ, e-mail, telefone ou chave aleatória"
        />
      </Field>

      <Field label="Observações">
        <TextArea
          name="notes"
          defaultValue={initial?.notes}
          placeholder="Anotações internas sobre o fornecedor (prazo de entrega, condições etc.)"
        />
      </Field>

      <FormError message={state.error} />
      <FormSuccess message={state.success} />

      <div>
        <SubmitButton>
          {initial ? "Salvar alterações" : "Cadastrar fornecedor"}
        </SubmitButton>
      </div>
    </form>
  );
}
