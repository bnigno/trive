"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Card } from "@/components/ui/card";
import { Button, Field, FormError, Input } from "@/components/ui/form";
import { formatUsdCents } from "@/core/ai/model-cost";
import { DRAFT_MAX_PHOTOS, type ProductDraft } from "@/core/catalog/product-draft";

import { draftFromPhotosAction } from "./actions";
import { shrinkImage } from "./shrink-image";

/** Teto do corpo da server action (8 MB), com folga para o resto do formulário. */
const DRAFT_TOTAL_BYTES = 6 * 1024 * 1024;

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

  /**
   * ACUMULA: no celular a câmera devolve uma foto por vez, e a dona precisa
   * mandar a peça E a etiqueta (e a tabela de medidas). Substituir a lista a
   * cada escolha deixaria só a última.
   */
  const handleFiles = useCallback((list: FileList | null) => {
    const chosen = Array.from(list ?? []).filter((file) => file.type.startsWith("image/"));
    if (chosen.length === 0) return;
    setFiles((current) => {
      const next = [...current, ...chosen].slice(0, DRAFT_MAX_PHOTOS);
      setError(
        current.length + chosen.length > DRAFT_MAX_PHOTOS
          ? `Guardei as ${DRAFT_MAX_PHOTOS} primeiras fotos.`
          : undefined,
      );
      return next;
    });
  }, []);

  const removeFile = useCallback((index: number) => {
    setFiles((current) => current.filter((_, position) => position !== index));
  }, []);

  async function handleSubmit() {
    if (busy || files.length === 0) return;
    setError(undefined);
    setPhase({ kind: "preparing" });

    let reduced;
    try {
      reduced = await Promise.all(files.map((file) => shrinkImage(file)));
    } catch {
      setPhase({ kind: "idle" });
      setError("Não consegui preparar as fotos neste aparelho. Tente com fotos menores.");
      return;
    }
    const smaller = reduced.map((item) => item.file);
    const total = smaller.reduce((sum, file) => sum + file.size, 0);
    // Formato que o navegador não decodifica (HEIC no Android, por exemplo):
    // o arquivo seguiria inteiro e a action recusaria com erro de rede.
    if (reduced.some((item) => !item.shrunk) && total > DRAFT_TOTAL_BYTES) {
      setPhase({ kind: "idle" });
      setError(
        "Este aparelho não consegue preparar fotos neste formato (HEIC). Nos ajustes da câmera escolha “Mais compatível” e fotografe de novo, ou mande uma foto por vez.",
      );
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
            {/* Sem `capture`: assim o celular oferece câmera E galeria, e a dona
                consegue juntar a peça, a etiqueta e a tabela de medidas. */}
            <input
              ref={inputRef}
              type="file"
              accept="image/*"
              multiple
              disabled={disabled || busy}
              onChange={(event) => {
                handleFiles(event.target.files);
                event.target.value = "";
              }}
              className="block w-full text-sm text-zinc-600 file:mr-3 file:rounded-md file:border-0 file:bg-zinc-900 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white dark:text-zinc-300 dark:file:bg-zinc-100 dark:file:text-zinc-900"
            />
          </Field>
          <Field label="Quanto custou para você (R$)" hint="É com este custo que eu sugiro o preço de venda.">
            <Input
              inputMode="decimal"
              value={cost}
              disabled={disabled || busy}
              onChange={(event) => setCost(event.target.value)}
              onKeyDown={(event) => {
                // Sem isto, o Enter/Go do teclado ENVIA o formulário do cadastro
                // e cria o produto sem revisão.
                if (event.key !== "Enter") return;
                event.preventDefault();
                void handleSubmit();
              }}
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
        </div>

        {files.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {files.map((file, index) => (
              <li
                key={`${file.name}-${index}`}
                className="flex items-center justify-between gap-3 rounded-md border border-zinc-200 px-3 py-1.5 text-sm dark:border-zinc-800"
              >
                <span className="truncate text-zinc-700 dark:text-zinc-300">{file.name}</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => removeFile(index)}
                  className="shrink-0 text-xs font-medium text-zinc-500 underline hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100"
                >
                  Remover
                </button>
              </li>
            ))}
          </ul>
        ) : null}

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
              A primeira foto entrou na lista de fotos da peça — confira lá embaixo
              (a etiqueta e a tabela de medidas não vão para a loja). Custo estimado
              desta ficha: {formatUsdCents(phase.costUsdCents)}.
            </p>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
