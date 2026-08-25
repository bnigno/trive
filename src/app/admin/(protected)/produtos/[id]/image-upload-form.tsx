"use client";

import { useActionState } from "react";
import { FormError, FormSuccess, SubmitButton } from "@/components/ui/form";
import { uploadImagesAction, type FormState } from "./actions";

const initialState: FormState = {};

export function ImageUploadForm({ productId }: { productId: string }) {
  const [state, formAction] = useActionState(uploadImagesAction, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="productId" value={productId} />
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="file"
          name="files"
          accept="image/*"
          multiple
          required
          className="text-sm text-zinc-600 file:mr-3 file:rounded-md file:border file:border-zinc-300 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-zinc-700 hover:file:bg-zinc-100 dark:text-zinc-400 dark:file:border-zinc-700 dark:file:bg-zinc-900 dark:file:text-zinc-300 dark:hover:file:bg-zinc-800"
        />
        <SubmitButton pendingLabel="Enviando…" size="sm">
          Enviar imagens
        </SubmitButton>
      </div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Você pode selecionar várias imagens de uma vez (máx. 8&nbsp;MB por
        envio).
      </p>
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
    </form>
  );
}
