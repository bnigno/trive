"use client";

import { useActionState } from "react";
import { ConfirmButton } from "@/components/ui/confirm-button";
import {
  FormError,
  FormSuccess,
  Select,
  SubmitButton,
} from "@/components/ui/form";
import {
  removeCategoryCoverAction,
  updateCategoryCoverFocusAction,
  uploadCategoryCoverAction,
  type FormState,
} from "./actions";

const initialState: FormState = {};

export const FOCUS_OPTIONS = [
  { value: "15", label: "Foco no topo" },
  { value: "50", label: "Foco no centro" },
  { value: "85", label: "Foco na base" },
] as const;

/** Envia (ou troca) a foto de capa de uma sala, com o foco vertical. */
export function CategoryCoverForm({
  categoryId,
  hasCover,
  focalY,
}: {
  categoryId: string;
  hasCover: boolean;
  focalY: number;
}) {
  const [state, formAction] = useActionState(uploadCategoryCoverAction, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="categoryId" value={categoryId} />
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="file"
          name="file"
          accept="image/jpeg,image/png,image/webp"
          required
          aria-label={hasCover ? "Trocar a foto de capa" : "Foto de capa"}
          className="max-w-56 text-sm text-zinc-600 file:mr-3 file:rounded-md file:border file:border-zinc-300 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-zinc-700 hover:file:bg-zinc-100 dark:text-zinc-400 dark:file:border-zinc-700 dark:file:bg-zinc-900 dark:file:text-zinc-300 dark:hover:file:bg-zinc-800"
        />
        <Select
          name="focalY"
          defaultValue={String(focalY)}
          aria-label="Foco da capa"
          className="w-auto"
        >
          {FOCUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
        <SubmitButton pendingLabel="Enviando…" size="sm">
          {hasCover ? "Trocar capa" : "Enviar capa"}
        </SubmitButton>
      </div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        JPG, PNG ou WebP até 8&nbsp;MB. Fotos em retrato funcionam melhor; o
        foco diz que parte da foto fica visível no recorte largo da coleção.
      </p>
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
    </form>
  );
}

/** Ajusta só o foco de uma capa já enviada. */
export function CategoryCoverFocusForm({
  categoryId,
  focalY,
}: {
  categoryId: string;
  focalY: number;
}) {
  const [state, formAction] = useActionState(
    updateCategoryCoverFocusAction,
    initialState,
  );

  return (
    <form action={formAction} className="flex flex-col gap-1">
      <input type="hidden" name="categoryId" value={categoryId} />
      <div className="flex flex-wrap items-center gap-2">
        <Select
          name="focalY"
          defaultValue={String(focalY)}
          aria-label="Foco da capa"
          className="w-auto"
        >
          {FOCUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
        <SubmitButton pendingLabel="Salvando…" size="sm" variant="outline">
          Salvar foco
        </SubmitButton>
      </div>
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
    </form>
  );
}

export function RemoveCategoryCoverForm({ categoryId }: { categoryId: string }) {
  return (
    <form action={removeCategoryCoverAction}>
      <input type="hidden" name="categoryId" value={categoryId} />
      <ConfirmButton
        size="sm"
        variant="ghost"
        confirmMessage="Remover a capa desta sala? Ela volta para a capa tipográfica."
      >
        Remover capa
      </ConfirmButton>
    </form>
  );
}
