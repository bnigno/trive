"use client";

// Etiqueta de cor de uma foto já enviada. Salva assim que o dono escolhe:
// um botão "salvar" por foto encheria a grade de imagens de controles.
import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { FormError, Select } from "@/components/ui/form";

import { setImageColorAction, type FormState } from "./actions";

const initialState: FormState = {};

function ColorSelect({
  color,
  options,
}: {
  color: string | null;
  options: string[];
}) {
  // useFormStatus só enxerga o envio de dentro do próprio <form>, por isso o
  // seletor mora em um componente separado.
  const { pending } = useFormStatus();

  return (
    <Select
      name="color"
      defaultValue={color ?? ""}
      disabled={pending}
      aria-label="Cor desta foto"
      className="px-2 py-1 text-xs"
      onChange={(event) => event.currentTarget.form?.requestSubmit()}
    >
      <option value="">Produto inteiro</option>
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </Select>
  );
}

export function ImageColorForm({
  imageId,
  productId,
  color,
  colorOptions,
}: {
  imageId: string;
  productId: string;
  color: string | null;
  colorOptions: string[];
}) {
  const [state, formAction] = useActionState(setImageColorAction, initialState);

  // A cor gravada pode não estar mais entre as variações (variação removida):
  // ela continua na lista para o seletor não exibir uma cor que não é a da foto.
  const options =
    color && !colorOptions.includes(color)
      ? [...colorOptions, color]
      : colorOptions;

  return (
    <form action={formAction} className="flex flex-col gap-1">
      <input type="hidden" name="imageId" value={imageId} />
      <input type="hidden" name="productId" value={productId} />
      <ColorSelect color={color} options={options} />
      <FormError message={state.error} />
    </form>
  );
}
