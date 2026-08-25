"use client";

import { useActionState } from "react";
import {
  Field,
  FormError,
  FormSuccess,
  Input,
  SubmitButton,
} from "@/components/ui/form";
import { addVariantAction, updateVariantAction, type FormState } from "./actions";

const initialState: FormState = {};

export function AddVariantForm({
  productId,
  axes,
}: {
  productId: string;
  axes: string[];
}) {
  const [state, formAction] = useActionState(addVariantAction, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="productId" value={productId} />
      <div className="flex flex-wrap items-end gap-3">
        {axes.map((axis) => (
          <Field key={axis} label={axis} className="min-w-32 flex-1">
            <Input name={`attr:${axis}`} required />
          </Field>
        ))}
        <Field label="SKU" className="min-w-36 flex-1">
          <Input name="sku" required placeholder="Código único" />
        </Field>
        <SubmitButton pendingLabel="Adicionando…" size="sm" className="mb-1">
          Adicionar variação
        </SubmitButton>
      </div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        O custo e o preço de venda da nova variação são definidos na calculadora
        de preços.
      </p>
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
    </form>
  );
}

export function EditVariantForm({
  productId,
  variant,
  axes,
}: {
  productId: string;
  variant: { id: string; sku: string; attributes: Record<string, string> };
  axes: string[];
}) {
  const [state, formAction] = useActionState(updateVariantAction, initialState);

  // Edita também eixos antigos que não estão mais no cadastro do produto.
  const editableAxes = [
    ...axes,
    ...Object.keys(variant.attributes).filter((key) => !axes.includes(key)),
  ];

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="variantId" value={variant.id} />
      <div className="flex flex-wrap items-end gap-3">
        <Field
          label="SKU (travado)"
          className="min-w-36 flex-1"
          hint="O SKU não pode ser alterado depois de criado."
        >
          <Input value={variant.sku} disabled readOnly />
        </Field>
        {editableAxes.map((axis) => (
          <Field key={axis} label={axis} className="min-w-32 flex-1">
            <Input
              name={`attr:${axis}`}
              defaultValue={variant.attributes[axis] ?? ""}
              required
            />
          </Field>
        ))}
        <SubmitButton pendingLabel="Salvando…" size="sm" className="mb-1">
          Salvar
        </SubmitButton>
      </div>
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
    </form>
  );
}
