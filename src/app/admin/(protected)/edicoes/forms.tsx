"use client";
import { startTransition, useActionState, useState } from "react";

import { shrinkImage, uploadBlocker } from "@/components/admin/shrink-image";
import { Field, FormError, FormSuccess, Input, SubmitButton, TextArea } from "@/components/ui/form";

import {
  createCityEditionAction,
  setCityEditionProductsAction,
  updateCityEditionAction,
  uploadCityEditionCoverAction,
  useEditionOnCardsAction,
  type FormState,
} from "./actions";

const INITIAL: FormState = {};

export interface EditionFormValues {
  name: string;
  slug: string;
  openingLine: string | null;
  body: string | null;
  districts: string | null;
  startsOn: string | null;
  endsOn: string | null;
  hourStart: number | null;
  hourEnd: number | null;
  sortOrder: number;
  isActive: boolean;
}

function EditionFields({ values }: { values: EditionFormValues | null }) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Nome da edição" hint="Aparece na home, na coleção e na Lia. Ex.: Edição Círio.">
          <Input name="name" required maxLength={80} defaultValue={values?.name ?? ""} placeholder="Edição Círio" />
        </Field>
        <Field
          label="Endereço (slug)"
          hint={values ? "Vira /belem/<slug>. Vazio = mantém o atual. Mudar quebra links já divulgados." : "Vira /belem/<slug>. Vazio = a partir do nome."}
        >
          <Input name="slug" maxLength={80} defaultValue={values?.slug ?? ""} placeholder="vestida-para-o-cirio" />
        </Field>
      </div>
      <Field label="Frase de abertura" hint="Uma linha, no tom da maison. Ex.: Vestida para o Círio.">
        <Input name="openingLine" maxLength={160} defaultValue={values?.openingLine ?? ""} />
      </Field>
      <Field label="Parágrafo da curadora" hint="Por que esta edição existe. Quebra de linha vira parágrafo.">
        <TextArea name="body" rows={4} maxLength={4000} defaultValue={values?.body ?? ""} />
      </Field>
      <Field label="Bairros atendidos (opcional)" hint="Um por linha ou separados por vírgula. Ex.: Nazaré, Batista Campos, Umarizal.">
        <TextArea name="districts" rows={2} maxLength={2000} defaultValue={values?.districts ?? ""} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Começa em" hint="Dia de Belém (inclusive). Vazio = já vale.">
          <Input name="startsOn" type="date" defaultValue={values?.startsOn ?? ""} />
        </Field>
        <Field label="Termina em" hint="Dia de Belém (inclusive). Vazio = não termina.">
          <Input name="endsOn" type="date" defaultValue={values?.endsOn ?? ""} />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Das (hora)" hint="Só numa faixa do dia? Ex.: 14 para a “Chuva das 14h”.">
          <Input name="hourStart" type="number" min={0} max={23} defaultValue={values?.hourStart ?? ""} />
        </Field>
        <Field label="Até (hora)" hint="Hora em que deixa de valer. Ex.: 16.">
          <Input name="hourEnd" type="number" min={1} max={24} defaultValue={values?.hourEnd ?? ""} />
        </Field>
        <Field label="Ordem" hint="Menor aparece primeiro entre edições iguais.">
          <Input name="sortOrder" type="number" min={0} max={999} defaultValue={values?.sortOrder ?? 0} />
        </Field>
      </div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Quando duas edições valem ao mesmo tempo, a de hora manda sobre a de período, que manda sobre a permanente. A vitrine
        acompanha em até 5 minutos.
      </p>
    </>
  );
}

export function EditionCreateForm() {
  const [state, action] = useActionState(createCityEditionAction, INITIAL);
  return (
    <form action={action} className="flex flex-col gap-4">
      <EditionFields values={null} />
      <label className="flex items-center gap-2 text-sm text-zinc-800 dark:text-zinc-200">
        <input type="checkbox" name="isActive" className="h-4 w-4 accent-zinc-900" />
        Já colocar no ar (recomendado só depois de escolher capa e peças)
      </label>
      <FormError message={state.error} />
      <div>
        <SubmitButton pendingLabel="Criando…">Criar edição</SubmitButton>
      </div>
    </form>
  );
}

export function EditionEditForm({ editionId, values }: { editionId: string; values: EditionFormValues }) {
  const [state, action] = useActionState(updateCityEditionAction, INITIAL);
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="editionId" value={editionId} />
      <EditionFields values={values} />
      <label className="flex items-center gap-2 text-sm text-zinc-800 dark:text-zinc-200">
        <input type="checkbox" name="isActive" defaultChecked={values.isActive} className="h-4 w-4 accent-zinc-900" />
        Edição ativa (aparece na vitrine quando estiver na vigência)
      </label>
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      <div>
        <SubmitButton>Salvar</SubmitButton>
      </div>
    </form>
  );
}

export function EditionCoverForm({ editionId }: { editionId: string }) {
  const [state, action, pending] = useActionState(uploadCityEditionCoverAction, INITIAL);
  const [localError, setLocalError] = useState<string | undefined>();
  const [preparing, setPreparing] = useState(false);

  // A Vercel aceita 4,5 MB por requisição: a foto é reduzida no navegador
  // antes de subir (mesmo caminho das fotos de produto).
  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const original = (event.currentTarget.elements.namedItem("cover") as HTMLInputElement | null)?.files?.[0];
    if (!original || original.size === 0) {
      setLocalError("Escolha a imagem da capa antes de enviar.");
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
      body.set("editionId", editionId);
      body.set("cover", reduced.file);
      startTransition(() => action(body));
    } finally {
      setPreparing(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <Field label="Capa" hint="JPG, PNG ou foto do celular: reduzimos no seu aparelho antes de subir. Formato paisagem funciona melhor na home.">
        <Input name="cover" type="file" accept="image/*" required />
      </Field>
      <FormError message={localError ?? state.error} />
      <FormSuccess message={state.success} />
      <div>
        <SubmitButton pendingLabel="Enviando…" disabled={preparing || pending}>
          {preparing ? "Preparando…" : "Enviar capa"}
        </SubmitButton>
      </div>
    </form>
  );
}

export function EditionProductsForm({
  editionId,
  options,
  selected,
}: {
  editionId: string;
  options: { id: string; name: string; status: string }[];
  /** As peças da edição, na ordem dela (sempre listadas, mesmo se não estiverem em `options`). */
  selected: { id: string; name: string; status: string }[];
}) {
  const [state, action] = useActionState(setCityEditionProductsAction, INITIAL);
  const selectedIds = selected.map((p) => p.id);
  // As já escolhidas vêm primeiro, na ordem da edição: a ordem da lista é a ordem na vitrine.
  const ordered = [...selected, ...options.filter((o) => !selectedIds.includes(o.id))];
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="editionId" value={editionId} />
      <ul className="max-h-96 divide-y divide-zinc-200 overflow-y-auto rounded-md border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
        {ordered.map((option) => (
          <li key={option.id} className="flex items-center gap-3 px-3 py-2 text-sm">
            <input
              type="checkbox"
              name="productIds"
              value={option.id}
              defaultChecked={selectedIds.includes(option.id)}
              className="h-4 w-4 accent-zinc-900"
            />
            <span className="flex-1 text-zinc-900 dark:text-zinc-100">{option.name}</span>
            <span className="text-xs text-zinc-500">{option.status === "draft" ? "rascunho" : option.status === "active" ? "ativa" : option.status}</span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Só peças ativas com preço e estoque aparecem na vitrine; as outras ficam guardadas na edição até ficarem prontas.
      </p>
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      <div>
        <SubmitButton>Salvar peças</SubmitButton>
      </div>
    </form>
  );
}

export function UseOnCardsForm({ editionId, name, currentCardsName }: { editionId: string; name: string; currentCardsName: string }) {
  const [state, action] = useActionState(useEditionOnCardsAction, INITIAL);
  const same = currentCardsName.trim() === name.trim();
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="editionId" value={editionId} />
      <input type="hidden" name="name" value={name} />
      <p className="text-sm text-zinc-700 dark:text-zinc-300">
        {same ? (
          <>Os cartões e posts já saem com “{name}”.</>
        ) : currentCardsName ? (
          <>Os cartões e posts hoje saem com “{currentCardsName}”. Trocar para “{name}”?</>
        ) : (
          <>Os cartões e posts ainda não têm nome de edição.</>
        )}
      </p>
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      {same ? null : (
        <div>
          <SubmitButton variant="outline" pendingLabel="Gravando…">Usar nos cartões e posts</SubmitButton>
        </div>
      )}
    </form>
  );
}
