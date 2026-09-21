"use client";
// Modelos da casa: gerar candidatas de uma combinação, escolher e descartar.
import { useActionState } from "react";

import { Button, FormError, FormSuccess } from "@/components/ui/form";
import { ConfirmButton } from "@/components/ui/confirm-button";

import { chooseBasePhotoAction, discardBasePhotoAction, requestBasePhotosAction, type BaseFormState } from "./actions";

const INITIAL_STATE: BaseFormState = {};

export function RequestBasePhotosForm({ modelKey, sceneKey, sizeKey, costLabel, pending }: { modelKey: string; sceneKey: string; sizeKey: string; costLabel: string; pending: boolean }) {
  const [state, formAction, submitting] = useActionState<BaseFormState, FormData>(requestBasePhotosAction, INITIAL_STATE);
  return (
    <form action={formAction} className="flex flex-col gap-1">
      <input type="hidden" name="modelKey" value={modelKey} />
      <input type="hidden" name="sceneKey" value={sceneKey} />
      <input type="hidden" name="sizeKey" value={sizeKey} />
      <Button type="submit" size="sm" variant="outline" disabled={submitting || pending}>
        {pending ? "Gerando…" : submitting ? "Colocando na fila…" : `Gerar 2 candidatas (≈ ${costLabel})`}
      </Button>
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
    </form>
  );
}

export function BasePhotoActions({ id, chosen }: { id: string; chosen: boolean }) {
  const [chooseState, choose, choosing] = useActionState<BaseFormState, FormData>(chooseBasePhotoAction, INITIAL_STATE);
  const [discardState, discard, discarding] = useActionState<BaseFormState, FormData>(discardBasePhotoAction, INITIAL_STATE);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-2">
        {chosen ? null : (
          <form action={choose}>
            <input type="hidden" name="id" value={id} />
            <Button type="submit" size="sm" disabled={choosing || discarding}>
              {choosing ? "Escolhendo…" : "Escolher"}
            </Button>
          </form>
        )}
        <form action={discard}>
          <input type="hidden" name="id" value={id} />
          <ConfirmButton size="sm" variant="outline" disabled={choosing || discarding} confirmMessage={chosen ? "Descartar a foto-base escolhida? Os ensaios desta modelo nesta cena param até você escolher outra." : "Descartar esta candidata?"}>
            {discarding ? "Descartando…" : "Descartar"}
          </ConfirmButton>
        </form>
      </div>
      <FormError message={chooseState.error ?? discardState.error} />
      <FormSuccess message={chooseState.success ?? discardState.success} />
    </div>
  );
}
