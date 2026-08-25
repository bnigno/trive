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
  adjustStockAction,
  receiveStockAction,
  type StockFormState,
} from "./actions";

const initialState: StockFormState = {};

export function ReceiveStockForm({ variantId }: { variantId: string }) {
  const [state, formAction] = useActionState(receiveStockAction, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="variantId" value={variantId} />
      <Field label="Quantidade recebida" hint="Número inteiro, ex.: 10">
        <Input name="quantity" inputMode="numeric" placeholder="Ex.: 10" required />
      </Field>
      <Field
        label="Custo unitário — R$ (opcional)"
        hint="Quanto você pagou por unidade. Se preencher, esse valor passa a ser o custo atual do produto e pode gerar uma sugestão de reprecificação."
      >
        <Input name="unitCost" inputMode="decimal" placeholder="Ex.: 1.234,56" />
      </Field>
      <Field label="Nota (opcional)">
        <TextArea
          name="note"
          placeholder="Ex.: compra do fornecedor X, nota fiscal 123"
        />
      </Field>
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      <div>
        <SubmitButton pendingLabel="Registrando…">Registrar entrada</SubmitButton>
      </div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Use quando chegar mercadoria. A quantidade entra no estoque físico na hora.
      </p>
    </form>
  );
}

export function AdjustStockForm({ variantId }: { variantId: string }) {
  const [state, formAction] = useActionState(adjustStockAction, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="variantId" value={variantId} />
      <Field
        label="Quantidade (com sinal)"
        hint="Use número positivo para acrescentar (ex.: 5) ou negativo para retirar (ex.: -5)."
      >
        <Input name="quantityDelta" inputMode="numeric" placeholder="Ex.: -2" required />
      </Field>
      <Field
        label="Motivo do ajuste"
        hint="Obrigatório. Explique o que aconteceu, ex.: contagem do inventário encontrou 2 a menos."
      >
        <TextArea name="note" placeholder="Ex.: recontagem do estoque em 25/08" required />
      </Field>
      <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
        <input
          type="checkbox"
          name="asLoss"
          className="h-4 w-4 rounded border-zinc-300 accent-indigo-600 dark:border-zinc-700"
        />
        É perda ou quebra (produto danificado, vencido ou extraviado)
      </label>
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      <div>
        <SubmitButton pendingLabel="Registrando…">Registrar ajuste</SubmitButton>
      </div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Ajustes ficam registrados para sempre no histórico — nada é apagado.
      </p>
    </form>
  );
}
