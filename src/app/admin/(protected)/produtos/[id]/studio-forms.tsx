"use client";

// Bloco "Foto no corpo" da peça: pedir 3 opções (cor, cena, modelo, corpo,
// qualidade) com o custo estimado ao lado do botão; escolher ou descartar
// uma candidata. Sem regra aqui: o custo vem do core e as decisões do service.
import { useActionState, useState } from "react";

import type { StudioQuality } from "@/core/studio/presets";
import { Button, Field, FormError, FormSuccess, Select, SubmitButton } from "@/components/ui/form";
import { ConfirmButton } from "@/components/ui/confirm-button";

import { chooseStudioCandidateAction, discardStudioCandidateAction, requestStudioPhotosAction, type FormState } from "./actions";

const INITIAL_STATE: FormState = {};

export type StudioOption = { key: string; label: string; description?: string; available?: boolean };

/** Custo já formatado ("R$ 2,09") por qualidade e por nº de opções (1–4): a conta é do servidor. */
export type StudioEstimates = Record<StudioQuality, string[]>;

export function RequestStudioForm({
  productId,
  colorOptions,
  scenes,
  models,
  sizes,
  defaults,
  estimates,
}: {
  productId: string;
  colorOptions: string[];
  scenes: StudioOption[];
  models: StudioOption[];
  sizes: StudioOption[];
  defaults: { sceneKey: string; modelKey: string; sizeKey: string; quality: StudioQuality };
  estimates: StudioEstimates;
}) {
  const [state, formAction] = useActionState(requestStudioPhotosAction, INITIAL_STATE);
  const [quality, setQuality] = useState<StudioQuality>(defaults.quality);
  const [options, setOptions] = useState(3);
  const brl = estimates[quality][options - 1] ?? estimates[quality][2] ?? "";

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="productId" value={productId} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {colorOptions.length > 0 ? (
          <Field label="Cor" hint="A foto real desta cor é a que veste a modelo.">
            <Select name="color" defaultValue={colorOptions[0]} required>
              {colorOptions.map((color) => (
                <option key={color} value={color}>
                  {color}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <Field label="Cena">
          <Select name="sceneKey" defaultValue={defaults.sceneKey}>
            {scenes.map((scene) => (
              <option key={scene.key} value={scene.key}>
                {scene.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Modelo" hint="Só combinações com foto-base escolhida em Modelos da casa funcionam.">
          <Select name="modelKey" defaultValue={defaults.modelKey}>
            {models.map((model) => (
              <option key={model.key} value={model.key}>
                {model.label}
                {model.available === false ? " — sem foto-base" : ""}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Corpo">
          <Select name="sizeKey" defaultValue={defaults.sizeKey}>
            {sizes.map((size) => (
              <option key={size.key} value={size.key}>
                {size.label}
                {size.available === false ? " — sem foto-base" : ""}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Qualidade" hint="Econômica: 1 crédito por foto. Alta: 3 créditos, em 2K.">
          <Select name="quality" value={quality} onChange={(event) => setQuality(event.currentTarget.value === "alta" ? "alta" : "economica")}>
            <option value="economica">Econômica</option>
            <option value="alta">Alta (2K)</option>
          </Select>
        </Field>
        <Field label="Opções">
          <Select name="options" value={String(options)} onChange={(event) => setOptions(Number(event.currentTarget.value) || 3)}>
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={String(n)}>
                {n}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <FormError message={state.error} />
      <FormSuccess message={state.success} />

      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Colocando na fila…">Gerar {options === 1 ? "1 opção" : `${options} opções`}</SubmitButton>
        <span className="text-sm text-zinc-600 dark:text-zinc-300">
          ≈ {brl} <span className="text-zinc-400">(gerar + conferir, já com a retentativa do portão)</span>
        </span>
      </div>
    </form>
  );
}

export function CandidateActions({ candidateId, productId, canChoose }: { candidateId: string; productId: string; canChoose: boolean }) {
  const [chooseState, choose, choosing] = useActionState<FormState, FormData>(chooseStudioCandidateAction, INITIAL_STATE);
  const [discardState, discard, discarding] = useActionState<FormState, FormData>(discardStudioCandidateAction, INITIAL_STATE);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-2">
        {canChoose ? (
          <form action={choose}>
            <input type="hidden" name="candidateId" value={candidateId} />
            <input type="hidden" name="productId" value={productId} />
            <Button type="submit" size="sm" disabled={choosing || discarding}>
              {choosing ? "Guardando…" : "Escolher"}
            </Button>
          </form>
        ) : null}
        <form action={discard}>
          <input type="hidden" name="candidateId" value={candidateId} />
          <input type="hidden" name="productId" value={productId} />
          <ConfirmButton size="sm" variant="outline" disabled={choosing || discarding} confirmMessage="Descartar esta opção? Ela some da lista (a foto fica só no histórico).">
            {discarding ? "Descartando…" : "Descartar"}
          </ConfirmButton>
        </form>
      </div>
      <FormError message={chooseState.error ?? discardState.error} />
      <FormSuccess message={chooseState.success ?? discardState.success} />
    </div>
  );
}
