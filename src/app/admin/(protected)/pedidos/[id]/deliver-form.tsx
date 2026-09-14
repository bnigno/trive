"use client";

// "Entregue — enviar foto": no celular, a câmera abre (capture=environment),
// a dona fotografa o pacote na mão da cliente/portaria, diz quem recebeu e
// o pedido vira entregue. A foto é reduzida no navegador antes de subir
// (teto de 4,5 MB por requisição na Vercel) e — se a cliente aceitou avisos
// — vai para ela pelo WhatsApp com a legenda. Refazer só troca a foto.
import { startTransition, useActionState, useState } from "react";

import { shrinkImage, uploadBlocker } from "@/components/admin/shrink-image";
import { Button, FormError, FormSuccess, Input } from "@/components/ui/form";
import { deliverWithPhotoAction, type FormState } from "./actions";

const initialState: FormState = {};

export function DeliverForm({
  orderId,
  photoUrl,
  receivedBy,
  deliveredAtLabel,
  compact = false,
}: {
  orderId: string;
  /** URL pública da foto da entrega, ou null quando ainda não há. */
  photoUrl: string | null;
  receivedBy: string | null;
  deliveredAtLabel: string | null;
  /** Mesa de entrega: sem miniatura grande, botão direto. */
  compact?: boolean;
}) {
  const [state, formAction, pending] = useActionState(deliverWithPhotoAction, initialState);
  const [fileName, setFileName] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [localError, setLocalError] = useState<string | undefined>();
  const hasPhoto = photoUrl !== null;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const original = (form.elements.namedItem("photo") as HTMLInputElement | null)?.files?.[0];
    const who = String((form.elements.namedItem("receivedBy") as HTMLInputElement | null)?.value ?? "");
    if (!original || original.size === 0) {
      setLocalError("Tire (ou escolha) a foto da entrega antes de enviar.");
      return;
    }
    setLocalError(undefined);
    setPreparing(true);
    try {
      const reduced = await shrinkImage(original);
      const blocker = uploadBlocker(reduced);
      if (blocker) {
        setLocalError(blocker);
        return;
      }
      const body = new FormData();
      body.set("orderId", orderId);
      body.set("photo", reduced.file);
      body.set("receivedBy", who);
      startTransition(() => formAction(body));
    } finally {
      setPreparing(false);
    }
  }

  const busy = preparing || pending;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <input type="hidden" name="orderId" value={orderId} />
      {hasPhoto && !compact ? (
        <div className="flex items-start gap-3">
          <img src={photoUrl} alt="Foto da entrega" className="h-28 w-24 rounded-md border border-zinc-200 object-cover dark:border-zinc-700" />
          <div className="text-xs text-zinc-500 dark:text-zinc-400">
            <p className="font-medium text-zinc-700 dark:text-zinc-300">Entrega registrada</p>
            {deliveredAtLabel ? <p>{deliveredAtLabel}</p> : null}
            {receivedBy ? <p>Recebido por {receivedBy}</p> : null}
            <a href={photoUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-indigo-600 hover:underline dark:text-indigo-400">
              Abrir a foto
            </a>
          </div>
        </div>
      ) : null}

      <label className="flex cursor-pointer flex-col gap-1">
        <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{hasPhoto ? "Refazer a foto" : "Foto da entrega"}</span>
        <input
          type="file"
          name="photo"
          accept="image/*"
          capture="environment"
          required
          onChange={(event) => setFileName(event.target.files?.[0]?.name ?? null)}
          className="block w-full text-sm text-zinc-600 file:mr-3 file:rounded-md file:border-0 file:bg-zinc-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-zinc-800 hover:file:bg-zinc-200 dark:text-zinc-400 dark:file:bg-zinc-800 dark:file:text-zinc-200"
        />
        {fileName ? <span className="text-xs text-zinc-500 dark:text-zinc-400">{fileName}</span> : null}
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Recebido por (opcional)</span>
        <Input name="receivedBy" defaultValue={receivedBy ?? ""} placeholder="ex.: Maria (a própria) ou Portaria" maxLength={60} autoComplete="off" />
        <span className="text-xs text-zinc-500 dark:text-zinc-400">Só o primeiro nome vai para a cliente e para a página do pedido.</span>
      </label>

      <FormError message={localError ?? state.error} />
      <FormSuccess message={localError ? undefined : state.success} />

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy}>
          {preparing ? "Preparando a foto…" : pending ? "Enviando…" : hasPhoto ? "Trocar a foto" : "Entregue — enviar foto"}
        </Button>
      </div>
      {!compact ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Fotografe o pacote na mão de quem recebeu ou na portaria — sem endereço nem documento. A foto vai para a cliente pelo WhatsApp e fica na página
          do pedido, que pode ser encaminhada.
        </p>
      ) : null}
    </form>
  );
}
