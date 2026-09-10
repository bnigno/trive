"use client";

// "Embalei": foto do pacote tirada pelo celular (capture=environment abre a
// câmera). A action processa, guarda e — se a cliente aceitou avisos — manda
// a foto pelo WhatsApp. Refazer a foto só troca a imagem (não reenvia).
import { useActionState, useState } from "react";

import { FormError, FormSuccess, SubmitButton } from "@/components/ui/form";
import { packOrderAction, type FormState } from "./actions";

const initialState: FormState = {};

export function PackForm({
  orderId,
  photoUrl,
  packedAtLabel,
  compact = false,
}: {
  orderId: string;
  /** URL pública da foto atual, ou null quando ainda não há foto. */
  photoUrl: string | null;
  packedAtLabel: string | null;
  /** Mesa de embalagem: sem miniatura grande, botão direto. */
  compact?: boolean;
}) {
  const [state, formAction] = useActionState(packOrderAction, initialState);
  const [fileName, setFileName] = useState<string | null>(null);
  const hasPhoto = photoUrl !== null;

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="orderId" value={orderId} />
      {hasPhoto && !compact ? (
        <div className="flex items-start gap-3">
          <img
            src={photoUrl}
            alt="Foto do pacote"
            className="h-28 w-24 rounded-md border border-zinc-200 object-cover dark:border-zinc-700"
          />
          <div className="text-xs text-zinc-500 dark:text-zinc-400">
            <p className="font-medium text-zinc-700 dark:text-zinc-300">Foto registrada</p>
            {packedAtLabel ? <p>{packedAtLabel}</p> : null}
            <a
              href={photoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-block text-indigo-600 hover:underline dark:text-indigo-400"
            >
              Abrir a foto
            </a>
          </div>
        </div>
      ) : null}

      <label className="flex cursor-pointer flex-col gap-1">
        <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          {hasPhoto ? "Refazer a foto" : "Foto do pacote"}
        </span>
        <input
          type="file"
          name="photo"
          accept="image/*"
          capture="environment"
          required
          onChange={(event) => setFileName(event.target.files?.[0]?.name ?? null)}
          className="block w-full text-sm text-zinc-600 file:mr-3 file:rounded-md file:border-0 file:bg-zinc-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-zinc-800 hover:file:bg-zinc-200 dark:text-zinc-400 dark:file:bg-zinc-800 dark:file:text-zinc-200"
        />
        {fileName ? (
          <span className="text-xs text-zinc-500 dark:text-zinc-400">{fileName}</span>
        ) : null}
      </label>

      <FormError message={state.error} />
      <FormSuccess message={state.success} />

      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Enviando a foto…">
          {hasPhoto ? "Trocar a foto" : "Embalei — enviar foto"}
        </SubmitButton>
      </div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Fotografe só o pacote — sem etiqueta, endereço ou nota. A foto vai para
        a cliente pelo WhatsApp e fica na página do pedido, que pode ser
        encaminhada.
      </p>
    </form>
  );
}
