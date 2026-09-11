"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/form";
import {
  CURATOR_AUDIO_MAX_SECONDS,
  formatAudioSeconds,
} from "@/core/catalog/curator-note";

/**
 * Gravador de voz do painel: um toque para começar, outro para parar, e um
 * contador que para sozinho no limite. Onde o navegador não deixa gravar
 * (iOS antigo, permissão negada), sobra o caminho de sempre: escolher um
 * arquivo de áudio.
 */
export function AudioRecorder({
  disabled,
  onReady,
}: {
  disabled: boolean;
  /** Áudio pronto: o arquivo e quantos segundos ele tem. */
  onReady: (audio: { file: File; seconds: number }) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | undefined>();
  const recorderRef = useRef<MediaRecorder | null>(null);
  const startedAtRef = useRef(0);

  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => {
      setSeconds(Math.round((Date.now() - startedAtRef.current) / 1000));
    }, 250);
    return () => clearInterval(timer);
  }, [recording]);

  const stop = useCallback(() => {
    recorderRef.current?.stop();
  }, []);

  async function start() {
    setError(undefined);
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("Este aparelho não grava áudio pelo navegador. Escolha um arquivo abaixo.");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError("Não consegui usar o microfone. Autorize o acesso e tente de novo.");
      return;
    }

    // webm/opus onde houver; o iPhone entrega mp4/aac.
    const preferred = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(
      (type) => MediaRecorder.isTypeSupported?.(type) ?? false,
    );
    const recorder = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined);
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      const type = recorder.mimeType || "audio/webm";
      const blob = new Blob(chunks, { type });
      const total = Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000));
      setRecording(false);
      setSeconds(0);
      const extension = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
      onReady({
        file: new File([blob], `nota-curadora.${extension}`, { type }),
        seconds: Math.min(total, CURATOR_AUDIO_MAX_SECONDS),
      });
    };

    recorderRef.current = recorder;
    startedAtRef.current = Date.now();
    recorder.start();
    setRecording(true);
    // Para sozinho no limite: nota da curadora é curta por desenho.
    setTimeout(() => {
      if (recorder.state === "recording") recorder.stop();
    }, CURATOR_AUDIO_MAX_SECONDS * 1000);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant={recording ? "danger" : "primary"}
          disabled={disabled}
          onClick={() => (recording ? stop() : void start())}
        >
          {recording ? `Parar (${formatAudioSeconds(seconds)})` : "Gravar nota"}
        </Button>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          Até {CURATOR_AUDIO_MAX_SECONDS} segundos. Fale como você falaria para a cliente.
        </span>
      </div>

      <label className="text-xs text-zinc-500 dark:text-zinc-400">
        Ou escolha um áudio do aparelho:
        <input
          type="file"
          accept="audio/*"
          disabled={disabled || recording}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) onReady({ file, seconds: 0 });
          }}
          className="mt-1 block w-full text-sm text-zinc-600 file:mr-3 file:rounded-md file:border file:border-zinc-300 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-zinc-700 dark:text-zinc-400 dark:file:border-zinc-700 dark:file:bg-zinc-900 dark:file:text-zinc-300"
        />
      </label>

      {error ? (
        <p role="alert" className="text-sm text-amber-800 dark:text-amber-200">
          {error}
        </p>
      ) : null}
    </div>
  );
}
