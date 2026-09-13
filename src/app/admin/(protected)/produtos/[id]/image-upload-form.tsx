"use client";

// Fotos da peça: cada foto é reduzida no navegador (shrinkImage) e vai UMA por
// requisição — na Vercel o corpo de uma requisição tem teto de 4,5 MB, e um
// POST nativo com várias fotos cruas morria na borda mostrando a página de
// erro do navegador. Aqui nada é POST nativo: falha vira mensagem na tela.
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { shrinkImage, uploadBlocker } from "@/components/admin/shrink-image";
import { Button, FormError, FormSuccess } from "@/components/ui/form";

import { uploadImagesAction } from "./actions";

type Progress = { done: number; total: number };

export function ImageUploadForm({ productId }: { productId: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [success, setSuccess] = useState<string | undefined>();

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const files = Array.from(inputRef.current?.files ?? []).filter((file) => file.size > 0);
    if (files.length === 0) {
      setError("Selecione ao menos uma imagem.");
      setSuccess(undefined);
      return;
    }
    setError(undefined);
    setSuccess(undefined);
    startTransition(async () => {
      const failures: string[] = [];
      let sent = 0;
      for (const [index, original] of files.entries()) {
        setProgress({ done: index, total: files.length });
        const { file, shrunk } = await shrinkImage(original);
        const blocker = uploadBlocker(file.size, shrunk);
        if (blocker) {
          failures.push(`“${original.name}”: ${blocker}`);
          continue;
        }
        const body = new FormData();
        body.set("productId", productId);
        body.set("files", file);
        let outcome: { error?: string };
        try {
          outcome = await uploadImagesAction({}, body);
        } catch {
          outcome = { error: "não consegui falar com o servidor. Confira a conexão e tente de novo." };
        }
        if (outcome.error) failures.push(`“${original.name}”: ${outcome.error}`);
        else sent += 1;
      }
      setProgress(null);
      if (sent > 0) {
        setSuccess(sent === 1 ? "1 imagem enviada." : `${sent} imagens enviadas.`);
        if (inputRef.current) inputRef.current.value = "";
        // A action revalida as páginas; o refresh traz a galeria nova para esta tela.
        router.refresh();
      }
      if (failures.length > 0) {
        setError(
          failures.length === 1
            ? `Não subiu ${failures[0]}`
            : `Não subiram ${failures.length} fotos — ${failures.join(" · ")}`,
        );
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          name="files"
          accept="image/*"
          multiple
          required
          disabled={pending}
          className="text-sm text-zinc-600 file:mr-3 file:rounded-md file:border file:border-zinc-300 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-zinc-700 hover:file:bg-zinc-100 disabled:opacity-60 dark:text-zinc-400 dark:file:border-zinc-700 dark:file:bg-zinc-900 dark:file:text-zinc-300 dark:hover:file:bg-zinc-800"
        />
        <Button type="submit" size="sm" disabled={pending}>
          {pending && progress ? `Enviando ${Math.min(progress.done + 1, progress.total)} de ${progress.total}…` : pending ? "Preparando…" : "Enviar imagens"}
        </Button>
      </div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Pode selecionar várias de uma vez. As fotos são reduzidas aqui mesmo antes de subir e vão uma a uma — foto de celular entra sem problema.
      </p>
      <FormError message={error} />
      <FormSuccess message={success} />
    </form>
  );
}
