"use client";

import { useActionState, useState } from "react";

import { AudioRecorder } from "@/components/admin/audio-recorder";
import { Button, Field, FormError, FormSuccess, TextArea } from "@/components/ui/form";
import {
  CURATOR_NOTE_MAX_CHARS,
  formatAudioSeconds,
} from "@/core/catalog/curator-note";

import {
  recordCuratorNoteAction,
  removeCuratorAudioAction,
  updateCuratorNoteAction,
} from "./actions";

const INITIAL: { error?: string; success?: string } = {};

/**
 * A nota da curadora na tela da peça: a dona grava a voz, o texto vem da
 * transcrição e ela corrige antes de salvar. O áudio fica guardado (a Lia vai
 * poder mandar para a cliente); "Remover áudio" deixa só o texto.
 */
export function CuratorNoteForm({
  productId,
  note,
  audioUrl,
  audioSeconds,
}: {
  productId: string;
  note: string;
  /** URL pública do áudio já gravado (com carimbo para furar cache). */
  audioUrl: string | null;
  audioSeconds: number | null;
}) {
  const [recordState, recordAction, recording] = useActionState(
    recordCuratorNoteAction,
    INITIAL,
  );
  const [textState, textAction] = useActionState(updateCuratorNoteAction, INITIAL);
  const [removeState, removeAction] = useActionState(removeCuratorAudioAction, INITIAL);
  const [pending, setPending] = useState<{ file: File; seconds: number } | null>(null);

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
        Fale sobre a peça como você falaria para uma cliente na loja: o tecido,
        o caimento, para que ocasião ela pediu. O texto aparece na página da
        peça e a vendedora usa nas conversas.
      </p>

      {audioUrl ? (
        <div className="flex flex-col gap-2">
          <audio controls src={audioUrl} className="w-full" />
          <div className="flex flex-wrap items-center gap-3">
            {audioSeconds ? (
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {formatAudioSeconds(audioSeconds)} de gravação
              </span>
            ) : null}
            <form action={removeAction}>
              <input type="hidden" name="productId" value={productId} />
              <Button type="submit" variant="ghost">
                Remover áudio
              </Button>
            </form>
          </div>
          <FormError message={removeState.error} />
          <FormSuccess message={removeState.success} />
        </div>
      ) : null}

      <form action={recordAction} className="flex flex-col gap-3">
        <input type="hidden" name="productId" value={productId} />
        <input type="hidden" name="seconds" value={pending?.seconds ?? 0} />
        <AudioRecorder
          disabled={recording}
          onReady={(audio) => {
            setPending(audio);
          }}
        />
        {pending ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-zinc-700 dark:text-zinc-300">
              Gravação pronta{pending.seconds > 0 ? ` (${formatAudioSeconds(pending.seconds)})` : ""}.
            </span>
            <Button type="submit" disabled={recording}>
              {recording ? "Enviando…" : "Enviar e transcrever"}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setPending(null)}>
              Descartar
            </Button>
          </div>
        ) : null}
        {/* O arquivo entra no envio pelo estado do gravador. */}
        <AudioField file={pending?.file ?? null} />
        <FormError message={recordState.error} />
        <FormSuccess message={recordState.success} />
      </form>

      <form action={textAction} className="flex flex-col gap-3">
        <input type="hidden" name="productId" value={productId} />
        <Field
          label="Texto da nota"
          hint={`Até ${CURATOR_NOTE_MAX_CHARS} caracteres. Vazio tira a nota da página da peça.`}
        >
          <TextArea name="note" rows={4} defaultValue={note} maxLength={CURATOR_NOTE_MAX_CHARS} />
        </Field>
        <div>
          <Button type="submit">Salvar nota</Button>
        </div>
        <FormError message={textState.error} />
        <FormSuccess message={textState.success} />
      </form>
    </div>
  );
}

/**
 * O arquivo gravado vira um `<input type="file">` de verdade, porque o envio
 * do formulário é o que carrega o áudio para a action.
 */
function AudioField({ file }: { file: File | null }) {
  return (
    <input
      type="file"
      name="audio"
      accept="audio/*"
      hidden
      ref={(input) => {
        if (!input) return;
        const transfer = new DataTransfer();
        if (file) transfer.items.add(file);
        input.files = transfer.files;
      }}
    />
  );
}
