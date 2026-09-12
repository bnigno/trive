"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { useFormStatus } from "react-dom";

import { AudioRecorder } from "@/components/admin/audio-recorder";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Button, Field, FormError, FormSuccess, SubmitButton, TextArea } from "@/components/ui/form";
import {
  CURATOR_NOTE_MAX_CHARS,
  formatAudioSeconds,
} from "@/core/catalog/curator-note";

import {
  recordCuratorNoteAction,
  removeCuratorAudioAction,
  updateCuratorNoteAction,
  type CuratorNoteFormState,
} from "./actions";

const INITIAL: CuratorNoteFormState = {};

type PendingAudio = { file: File; seconds: number };

/**
 * A nota da curadora na tela da peça: a dona grava a voz, o texto vem da
 * transcrição e ela corrige antes de salvar. O áudio fica guardado (a Lia vai
 * poder mandar para a cliente); "Remover áudio" deixa só o texto.
 */
export function CuratorNoteForm({
  productId,
  note,
  noteVersion,
  audioUrl,
  audioMime,
  audioSeconds,
  transcriptionEnabled,
}: {
  productId: string;
  note: string;
  /** Muda quando o texto salvo muda: remonta o campo para mostrar a transcrição nova. */
  noteVersion: string;
  /** URL pública do áudio já gravado (o caminho muda a cada gravação). */
  audioUrl: string | null;
  audioMime: string | null;
  audioSeconds: number | null;
  /** Há chave da OpenAI neste ambiente? Sem ela, o áudio fica e o texto é à mão. */
  transcriptionEnabled: boolean;
}) {
  const [pending, setPending] = useState<PendingAudio | null>(null);
  const [recordState, recordAction, recording] = useActionState(
    async (prev: CuratorNoteFormState, formData: FormData): Promise<CuratorNoteFormState> => {
      let result: CuratorNoteFormState;
      try {
        result = await recordCuratorNoteAction(prev, formData);
      } catch {
        // Rede que caiu no meio do envio: a gravação continua aqui, não some.
        return {
          error: "Não consegui enviar a gravação (sem conexão?). Ela continua aqui embaixo: toque em Enviar de novo.",
          retryable: true,
        };
      }
      // A gravação pendente só fica quando reenviar o mesmo áudio pode ajudar
      // (serviço instável, cota). Sem chave, recusado ou sem fala, reenviar
      // não muda nada — a tela já disse o que fazer.
      if (!result.error && !result.retryable) setPending(null);
      return result;
    },
    INITIAL,
  );
  const [textState, textAction] = useActionState(updateCuratorNoteAction, INITIAL);
  const [removeState, removeAction] = useActionState(removeCuratorAudioAction, INITIAL);

  // Ouvir antes de enviar: a gravação nova substitui a salva, então vale
  // conferir. A URL de objeto vive enquanto a gravação pendente viver.
  const pendingUrl = useMemo(() => (pending ? URL.createObjectURL(pending.file) : null), [pending]);
  useEffect(
    () => () => {
      if (pendingUrl) URL.revokeObjectURL(pendingUrl);
    },
    [pendingUrl],
  );


  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
        Fale sobre a peça como você falaria para uma cliente na loja: o tecido,
        o caimento, para que ocasião ela pediu. O texto fica guardado na ficha
        da peça; em breve aparece na página da peça e nas conversas da Lia.
      </p>
      {!transcriptionEnabled ? (
        <p className="text-sm leading-relaxed text-amber-900 dark:text-amber-100">
          A transcrição automática está desligada neste ambiente (falta a chave
          da OpenAI na hospedagem). O áudio é guardado; escreva o texto à mão.
        </p>
      ) : null}

      {audioUrl ? (
        <div className="flex flex-col gap-2">
          <SavedAudioPlayer key={audioUrl} url={audioUrl} mime={audioMime} />
          <div className="flex flex-wrap items-center gap-3">
            {audioSeconds ? (
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {formatAudioSeconds(audioSeconds)} de gravação
              </span>
            ) : null}
            <form action={removeAction}>
              <input type="hidden" name="productId" value={productId} />
              <RemoveAudioButton />
            </form>
          </div>
        </div>
      ) : null}
      {/* Fora do bloco do player: depois de remover, o player some e a mensagem fica. */}
      <FormError message={removeState.error} />
      <FormSuccess message={removeState.success} />

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
          <div className="flex flex-col gap-2">
            {pendingUrl ? <audio controls src={pendingUrl} className="w-full" /> : null}
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm text-zinc-700 dark:text-zinc-300">
                Gravação pronta{pending.seconds > 0 ? ` (${formatAudioSeconds(pending.seconds)})` : ""}.
                {audioUrl ? " Ao enviar, ela substitui a gravação salva." : ""}
              </span>
              <Button type="submit" disabled={recording}>
                {recording ? "Enviando…" : transcriptionEnabled ? "Enviar e transcrever" : "Enviar"}
              </Button>
              <Button type="button" variant="ghost" disabled={recording} onClick={() => setPending(null)}>
                Descartar
              </Button>
            </div>
          </div>
        ) : null}
        {/* O arquivo entra no envio pelo estado do gravador. */}
        <AudioField file={pending?.file ?? null} />
        <FormError message={recordState.error} />
        {recordState.warning ? (
          <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
            {recordState.warning}
          </p>
        ) : null}
        <FormSuccess message={recordState.success} />
      </form>

      {/* A chave remonta o campo quando o texto salvo muda (regravação): um
          textarea não controlado não acompanha o defaultValue sozinho. */}
      <form key={noteVersion} action={textAction} className="flex flex-col gap-3">
        <input type="hidden" name="productId" value={productId} />
        <Field
          label="Texto da nota"
          hint={`Até ${CURATOR_NOTE_MAX_CHARS} caracteres. Vazio apaga a nota.`}
        >
          <TextArea name="note" rows={4} defaultValue={note} maxLength={CURATOR_NOTE_MAX_CHARS} />
        </Field>
        <div>
          <SubmitButton pendingLabel="Salvando…">Salvar nota</SubmitButton>
        </div>
        <FormError message={textState.error} />
        <FormSuccess message={textState.success} />
      </form>
    </div>
  );
}

/**
 * O player do áudio salvo. O webm do Android não toca no Safari (e o ogg
 * tampouco): quando o navegador não abre o arquivo, a tela diz que o texto
 * continua. Montado com key pela URL: cada áudio novo nasce "tocável".
 */
function SavedAudioPlayer({ url, mime }: { url: string; mime: string | null }) {
  const [playable, setPlayable] = useState(true);
  return (
    <>
      <audio controls className="w-full" preload="metadata" src={url} onError={() => setPlayable(false)} />
      {!playable ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Este aparelho não toca esse formato de áudio{mime ? ` (${mime})` : ""}; o texto continua abaixo.
        </p>
      ) : null}
    </>
  );
}

/** Pede confirmação (apaga do bucket na hora) e mostra que está removendo. */
function RemoveAudioButton() {
  const { pending } = useFormStatus();
  return (
    <ConfirmButton
      variant="ghost"
      disabled={pending}
      confirmMessage="Remover a gravação? O texto continua, mas o áudio não pode ser recuperado."
    >
      {pending ? "Removendo…" : "Remover áudio"}
    </ConfirmButton>
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
