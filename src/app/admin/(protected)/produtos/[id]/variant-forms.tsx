"use client";

import { useActionState, useRef } from "react";
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
  suggestedSku,
}: {
  productId: string;
  variant: { id: string; sku: string; attributes: Record<string, string> };
  axes: string[];
  /** Código que o cadastro sugeriria hoje (nome atual + eixos). */
  suggestedSku: string;
}) {
  const [state, formAction] = useActionState(updateVariantAction, initialState);
  const skuInputRef = useRef<HTMLInputElement>(null);
  const showSuggestion = suggestedSku !== "" && suggestedSku !== variant.sku;

  // Edita também eixos antigos que não estão mais no cadastro do produto.
  const editableAxes = [
    ...axes,
    ...Object.keys(variant.attributes).filter((key) => !axes.includes(key)),
  ];

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="variantId" value={variant.id} />
      <input type="hidden" name="currentSku" value={variant.sku} />
      <div className="flex flex-wrap items-end gap-3">
        <Field
          label="Código (SKU)"
          className="min-w-48 flex-1"
          hint={
            showSuggestion
              ? undefined
              : "Letras viram maiúsculas e espaços viram hífen."
          }
        >
          <Input
            ref={skuInputRef}
            name="sku"
            defaultValue={variant.sku}
            required
            className="font-mono uppercase"
          />
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
      {showSuggestion ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Sugestão pelo nome atual:{" "}
          <span className="font-mono text-zinc-900 dark:text-zinc-100">
            {suggestedSku}
          </span>{" "}
          <button
            type="button"
            onClick={() => {
              const input = skuInputRef.current;
              if (!input) return;
              input.value = suggestedSku;
              input.focus();
            }}
            className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
          >
            Usar
          </button>
        </p>
      ) : null}
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
    </form>
  );
}
