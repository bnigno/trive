"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/form";
import {
  CURATOR_AUDIO_MAX_BYTES,
  CURATOR_AUDIO_MAX_SECONDS,
  formatAudioSeconds,
} from "@/core/catalog/curator-note";

const MAX_MB = Math.round(CURATOR_AUDIO_MAX_BYTES / (1024 * 1024));

/** A mensagem certa para cada recusa do microfone — "tente de novo" não resolve bloqueio. */
function microphoneErrorMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "O microfone está bloqueado para este site. Toque no cadeado (ou no “aA”) ao lado do endereço, libere o Microfone e recarregue a página — ou escolha um arquivo abaixo.";
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return "O microfone está em uso por outro aplicativo (uma ligação?). Encerre e tente de novo.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "Não achei microfone neste aparelho. Escolha um arquivo de áudio abaixo.";
  }
  return "Não consegui usar o microfone. Autorize o acesso e tente de novo, ou escolha um arquivo abaixo.";
}

/** Duração de um arquivo escolhido do aparelho (null quando o navegador não sabe). */
function measureDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const probe = document.createElement("audio");
    const done = (value: number | null) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    probe.preload = "metadata";
    probe.onloadedmetadata = () =>
      done(Number.isFinite(probe.duration) && probe.duration > 0 ? probe.duration : null);
    probe.onerror = () => done(null);
    probe.src = url;
  });
}

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
  /** Áudio pronto: o arquivo e quantos segundos ele tem (0 = não sei). */
  onReady: (audio: { file: File; seconds: number }) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [starting, setStarting] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedAtRef = useRef(0);

  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => {
      setSeconds(Math.round((Date.now() - startedAtRef.current) / 1000));
    }, 250);
    return () => clearInterval(timer);
  }, [recording]);

  const releaseMicrophone = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  // Sair da tela no meio da gravação não pode deixar o microfone aberto.
  useEffect(
    () => () => {
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder && recorder.state !== "inactive") recorder.stop();
      releaseMicrophone();
    },
    [releaseMicrophone],
  );

  const stop = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
    recorderRef.current?.stop();
  }, []);

  async function start() {
    // Dois toques enquanto o navegador pergunta pela permissão criariam dois gravadores.
    if (starting || recording) return;
    setError(undefined);
    setNotice(undefined);
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("Este navegador não grava áudio. Escolha um arquivo abaixo.");
      return;
    }
    setStarting(true);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (permissionError) {
      setStarting(false);
      setError(microphoneErrorMessage(permissionError));
      return;
    }
    streamRef.current = stream;

    try {
      // webm/opus onde houver; o iPhone entrega mp4/aac.
      const preferred = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(
        (type) => MediaRecorder.isTypeSupported?.(type) ?? false,
      );
      const recorder = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined);
      const chunks: BlobPart[] = [];
      let stoppedAtLimit = false;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = () => {
        releaseMicrophone();
        setRecording(false);
        setSeconds(0);
        // Gravador de uma tela que já fechou (ou substituído): nada a entregar.
        if (recorderRef.current !== recorder) return;
        recorderRef.current = null;
        const type = recorder.mimeType || "audio/webm";
        const blob = new Blob(chunks, { type });
        if (blob.size === 0) {
          setError("A gravação ficou vazia — segure um instante a mais antes de parar e tente de novo.");
          return;
        }
        if (blob.size > CURATOR_AUDIO_MAX_BYTES) {
          setError(`A gravação passou de ${MAX_MB} MB. Grave de novo, mais curta.`);
          return;
        }
        if (stoppedAtLimit) {
          setNotice(
            `Parei em ${formatAudioSeconds(CURATOR_AUDIO_MAX_SECONDS)} — a nota vai até um minuto. Se cortou no meio, grave de novo, mais curta.`,
          );
        }
        const total = Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000));
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
      timeoutRef.current = setTimeout(() => {
        if (recorder.state === "recording") {
          stoppedAtLimit = true;
          recorder.stop();
        }
      }, CURATOR_AUDIO_MAX_SECONDS * 1000);
    } catch (recorderError) {
      // O microfone abriu, mas o gravador não: fechar o que abriu e dizer o que fazer.
      releaseMicrophone();
      recorderRef.current = null;
      console.warn("[audio-recorder] MediaRecorder falhou", recorderError);
      setError("Não consegui começar a gravar neste navegador. Escolha um arquivo abaixo.");
    } finally {
      setStarting(false);
    }
  }

  async function pickFile(file: File) {
    setError(undefined);
    setNotice(undefined);
    if (file.size > CURATOR_AUDIO_MAX_BYTES) {
      setError(
        `Esse áudio tem ${(file.size / (1024 * 1024)).toFixed(1)} MB; a nota vai até ${MAX_MB} MB. Grave pelo botão, é mais garantido.`,
      );
      return;
    }
    const duration = await measureDuration(file);
    if (duration !== null && duration > CURATOR_AUDIO_MAX_SECONDS + 1) {
      setError(
        `Esse áudio tem ${formatAudioSeconds(duration)}; a nota vai até ${formatAudioSeconds(CURATOR_AUDIO_MAX_SECONDS)}. Escolha um mais curto ou grave pelo botão.`,
      );
      return;
    }
    onReady({ file, seconds: duration === null ? 0 : Math.round(duration) });
  }

  const remaining = CURATOR_AUDIO_MAX_SECONDS - seconds;
  const label = recording
    ? remaining <= 5
      ? `Parar (faltam ${formatAudioSeconds(Math.max(0, remaining))})`
      : `Parar (${formatAudioSeconds(seconds)})`
    : starting
      ? "Abrindo o microfone…"
      : "Gravar nota";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant={recording ? "danger" : "primary"}
          disabled={disabled || starting}
          onClick={() => (recording ? stop() : void start())}
        >
          {label}
        </Button>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          Até {CURATOR_AUDIO_MAX_SECONDS} segundos. Fale como você falaria para a cliente.
        </span>
      </div>

      <label className="text-xs text-zinc-500 dark:text-zinc-400">
        Ou escolha um áudio do aparelho (até {MAX_MB} MB, um minuto):
        <input
          type="file"
          accept="audio/*"
          disabled={disabled || recording || starting}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void pickFile(file);
          }}
          className="mt-1 block w-full text-sm text-zinc-600 file:mr-3 file:rounded-md file:border file:border-zinc-300 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-zinc-700 dark:text-zinc-400 dark:file:border-zinc-700 dark:file:bg-zinc-900 dark:file:text-zinc-300"
        />
      </label>

      {notice ? (
        <p role="status" className="text-sm text-zinc-700 dark:text-zinc-300">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-amber-800 dark:text-amber-200">
          {error}
        </p>
      ) : null}
    </div>
  );
}
