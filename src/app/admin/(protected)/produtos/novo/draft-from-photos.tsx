"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Card } from "@/components/ui/card";
import { Button, Field, FormError, Input } from "@/components/ui/form";
import { formatUsdCents } from "@/core/catalog/model-cost";
import { DRAFT_MAX_PHOTOS, type ProductDraft } from "@/core/catalog/product-draft";

import { draftFromPhotosAction } from "./actions";
import { shrinkImage } from "./shrink-image";

export type DraftResult = {
  draft: ProductDraft;
  suggestedPriceCents: number | null;
  estimatedCostUsdCents: number;
  photos: File[];
  costInput: string;
};

type Phase =
  | { kind: "idle" }
  | { kind: "preparing" }
  | { kind: "thinking"; seconds: number }
  | { kind: "done"; warnings: string[]; costUsdCents: number };

/**
 * "Começar pela foto": 1–3 fotos (a peça, a etiqueta, a tabela de medidas) e
 * o custo. Volta a ficha preenchida para a dona revisar — nada é salvo aqui.
 */
export function DraftFromPhotos({
  disabled,
  onDraft,
}: {
  disabled: boolean;
  onDraft: (result: DraftResult) => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [cost, setCost] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [error, setError] = useState<string | undefined>();
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = phase.kind === "preparing" || phase.kind === "thinking";

  useEffect(() => {
    if (phase.kind !== "thinking") return;
    const timer = setInterval(() => {
      setPhase((current) => (current.kind === "thinking" ? { ...current, seconds: current.seconds + 1 } : current));
    }, 1000);
    return () => clearInterval(timer);
  }, [phase.kind]);

  const handleFiles = useCallback((list: FileList | null) => {
    const chosen = Array.from(list ?? []).filter((file) => file.type.startsWith("image/"));
    setFiles(chosen.slice(0, DRAFT_MAX_PHOTOS));
    setError(chosen.length > DRAFT_MAX_PHOTOS ? `Uso as ${DRAFT_MAX_PHOTOS} primeiras fotos.` : undefined);
  }, []);

  async function handleSubmit() {
    if (busy || files.length === 0) return;
    setError(undefined);
    setPhase({ kind: "preparing" });

    let smaller: File[];
    try {
      smaller = await Promise.all(files.map((file) => shrinkImage(file)));
    } catch {
      setPhase({ kind: "idle" });
      setError("Não consegui preparar as fotos neste aparelho. Tente com fotos menores.");
      return;
    }

    const body = new FormData();
    for (const file of smaller) body.append("photos", file);
    body.set("cost", cost);

    setPhase({ kind: "thinking", seconds: 0 });
    let result: Awaited<ReturnType<typeof draftFromPhotosAction>>;
    try {
      result = await draftFromPhotosAction({}, body);
    } catch {
      setPhase({ kind: "idle" });
      setError("Não consegui falar com o servidor. Tente de novo.");
      return;
    }

    if (!result.draft) {
      setPhase({ kind: "idle" });
      setError(result.error ?? "Não consegui montar a ficha. Tente de novo.");
      return;
    }

    setPhase({
      kind: "done",
      warnings: result.draft.warnings,
      costUsdCents: result.estimatedCostUsdCents ?? 0,
    });
    onDraft({
      draft: result.draft,
      suggestedPriceCents: result.suggestedPriceCents ?? null,
      estimatedCostUsdCents: result.estimatedCostUsdCents ?? 0,
      photos: smaller,
      costInput: cost,
    });
  }

  return (
    <Card title="Começar pela foto">
      <div className="flex flex-col gap-4">
        <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
          Fotografe a peça e a etiqueta de composição (e a tabela de medidas do
          fornecedor, se tiver). Eu preencho a ficha inteira para você revisar —
          nada é salvo até você tocar em “Criar produto”.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={`Fotos (até ${DRAFT_MAX_PHOTOS})`} hint="A peça, a etiqueta e, se tiver, a tabela de medidas.">
            <input
              ref={inputRef}
              type="file"
              accept="image/*"
              capture="environment"
              multiple
              disabled={disabled || busy}
              onChange={(event) => handleFiles(event.target.files)}
              className="block w-full text-sm text-zinc-600 file:mr-3 file:rounded-md file:border-0 file:bg-zinc-900 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white dark:text-zinc-300 dark:file:bg-zinc-100 dark:file:text-zinc-900"
            />
          </Field>
          <Field label="Quanto custou para você (R$)" hint="É com este custo que eu sugiro o preço de venda.">
            <Input
              inputMode="decimal"
              value={cost}
              disabled={disabled || busy}
              onChange={(event) => setCost(event.target.value)}
              placeholder="120,00"
            />
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={handleSubmit} disabled={disabled || busy || files.length === 0}>
            {phase.kind === "preparing"
              ? "Preparando as fotos…"
              : phase.kind === "thinking"
                ? `Montando a ficha… ${phase.seconds}s`
                : "Montar ficha"}
          </Button>
          {files.length > 0 && !busy ? (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {files.length === 1 ? "1 foto escolhida" : `${files.length} fotos escolhidas`}
            </p>
          ) : null}
        </div>

        <FormError message={error} />

        {phase.kind === "done" ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm leading-relaxed text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
            <p className="font-medium">Rascunho da IA — revise antes de publicar.</p>
            {phase.warnings.length > 0 ? (
              <ul className="mt-1 list-disc pl-5">
                {phase.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}
            <p className="mt-1 text-xs">
              As fotos já entraram na lista abaixo. Custo estimado desta ficha:{" "}
              {formatUsdCents(phase.costUsdCents)}.
            </p>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
