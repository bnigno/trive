"use client";

import { useActionState } from "react";

import {
  Field,
  FormError,
  FormSuccess,
  Input,
  Select,
  SubmitButton,
} from "@/components/ui/form";
import { createEntryAction, type FormState } from "./actions";

const initialState: FormState = {};

export function NewEntryForm() {
  const [state, formAction] = useActionState(createEntryAction, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <p className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-300">
        Receitas de vendas entram sozinhas quando o pedido é pago. Use este
        formulário para despesas e valores manuais, como aluguel ou fornecedor.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Tipo">
          <Select name="direction" defaultValue="payable">
            <option value="payable">Saída (a pagar)</option>
            <option value="receivable">Entrada (a receber)</option>
          </Select>
        </Field>
        <Field label="Categoria">
          <Select name="category" defaultValue="supplier">
            <option value="supplier">Fornecedor</option>
            <option value="shipping_cost">Frete</option>
            <option value="mp_fee">Taxa MP</option>
            <option value="refund">Reembolso</option>
            <option value="other">Outros</option>
          </Select>
        </Field>
      </div>

      <Field label="Descrição">
        <Input
          name="description"
          required
          placeholder="Ex.: Aluguel de agosto"
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Valor (R$)" hint="Use vírgula para centavos">
          <Input name="amount" required inputMode="decimal" placeholder="1.234,56" />
        </Field>
        <Field label="Vencimento (opcional)">
          <Input name="dueDate" type="date" />
        </Field>
      </div>

      <FormError message={state.error} />
      <FormSuccess message={state.success} />

      <div>
        <SubmitButton pendingLabel="Criando…">Criar lançamento</SubmitButton>
      </div>
    </form>
  );
}
