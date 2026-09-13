"use client";
import { useActionState } from "react";

import { Field, FormError, FormSuccess, Input, Select, SubmitButton, TextArea } from "@/components/ui/form";

import {
  cancelDropAction,
  createDropAction,
  generateDropStoryAction,
  previewAudienceAction,
  scheduleDropAction,
  setDropProductsAction,
  updateDropAction,
  type FormState,
  type PreviewState,
} from "./actions";

const INITIAL: FormState = {};

const WINDOW_OPTIONS = [
  { value: "6", label: "6 horas antes" },
  { value: "12", label: "12 horas antes" },
  { value: "24", label: "1 dia antes" },
  { value: "48", label: "2 dias antes" },
  { value: "72", label: "3 dias antes" },
];

export function DropCreateForm() {
  const [state, action] = useActionState(createDropAction, INITIAL);
  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Nome do lançamento" hint="Aparece no convite. Ex.: Edição Primavera.">
          <Input name="name" required maxLength={80} placeholder="Edição Primavera" />
        </Field>
        <Field label="Publicação para todo mundo" hint="Data e hora de São Paulo.">
          <Input name="publishAt" type="datetime-local" required />
        </Field>
        <Field label="Janela VIP" hint="Quanto tempo antes as convidadas veem primeiro.">
          <Select name="vipWindowHours" defaultValue="24">
            {WINDOW_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Limite de convidadas" hint="As de maior afinidade entram primeiro. Comece pequeno (20) no primeiro.">
          <Input name="audienceLimit" type="number" min={1} max={500} defaultValue={20} />
        </Field>
      </div>
      <Field label="Mensagem do convite (opcional)" hint="Vazio = usa o template “Convite VIP de lançamento”. Pode usar {{nome}}, {{lancamento}}, {{pecas}}, {{prazo}}, {{link}}.">
        <TextArea name="messageOverride" rows={3} maxLength={600} />
      </Field>
      <FormError message={state.error} />
      <div>
        <SubmitButton>Criar lançamento</SubmitButton>
      </div>
    </form>
  );
}

export function DropEditForm({
  drop,
  publishAtLocal,
  editable,
}: {
  drop: { id: string; name: string; vipWindowHours: number; audienceLimit: number; messageOverride: string | null };
  publishAtLocal: string;
  editable: boolean;
}) {
  const [state, action] = useActionState(updateDropAction, INITIAL);
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="dropId" value={drop.id} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Nome">
          <Input name="name" defaultValue={drop.name} maxLength={80} required />
        </Field>
        <Field label="Publicação" hint={editable ? "Data e hora de São Paulo." : "Cancele o agendamento para mudar."}>
          <Input name="publishAt" type="datetime-local" defaultValue={publishAtLocal} disabled={!editable} />
        </Field>
        <Field label="Janela VIP">
          <Select name="vipWindowHours" defaultValue={String(drop.vipWindowHours)} disabled={!editable}>
            {WINDOW_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Limite de convidadas">
          <Input name="audienceLimit" type="number" min={1} max={500} defaultValue={drop.audienceLimit} disabled={!editable} />
        </Field>
      </div>
      <Field label="Mensagem do convite (opcional)" hint="Vazio = template. Variáveis: {{nome}}, {{lancamento}}, {{pecas}}, {{prazo}}, {{link}}.">
        <TextArea name="messageOverride" rows={3} maxLength={600} defaultValue={drop.messageOverride ?? ""} />
      </Field>
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      <div>
        <SubmitButton>Salvar</SubmitButton>
      </div>
    </form>
  );
}

export function DropProductsForm({
  dropId,
  options,
  selected,
  editable,
}: {
  dropId: string;
  options: { id: string; name: string; status: string; hint: string | null }[];
  selected: string[];
  editable: boolean;
}) {
  const [state, action] = useActionState(setDropProductsAction, INITIAL);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="dropId" value={dropId} />
      <ul className="max-h-80 divide-y divide-zinc-200 overflow-y-auto rounded-md border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
        {options.map((option) => (
          <li key={option.id} className="flex items-center gap-3 px-3 py-2 text-sm">
            <input
              type="checkbox"
              name="productIds"
              value={option.id}
              defaultChecked={selected.includes(option.id)}
              disabled={!editable}
              className="h-4 w-4 accent-zinc-900"
            />
            <span className="flex-1 text-zinc-900 dark:text-zinc-100">{option.name}</span>
            <span className="text-xs text-zinc-500">{option.status === "draft" ? "rascunho" : option.status === "active" ? "ativa" : option.status}</span>
            {option.hint ? <span className="text-xs text-amber-700 dark:text-amber-400">{option.hint}</span> : null}
          </li>
        ))}
      </ul>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Peça em rascunho vira ativa ao agendar, mas fica escondida da vitrine até a publicação. Precisa de preço, estoque e foto.
      </p>
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      {editable ? (
        <div>
          <SubmitButton>Salvar peças</SubmitButton>
        </div>
      ) : null}
    </form>
  );
}

export function AudiencePreviewForm({ dropId }: { dropId: string }) {
  const [state, action] = useActionState(previewAudienceAction, {} as PreviewState);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="dropId" value={dropId} />
      <div>
        <SubmitButton>Calcular público</SubmitButton>
      </div>
      <FormError message={state.error} />
      {state.preview ? (
        <div className="text-sm">
          <p className="font-medium text-zinc-900 dark:text-zinc-100">
            {state.preview.eligible} {state.preview.eligible === 1 ? "cliente bate" : "clientes batem"} com as peças
            {state.preview.eligible > state.preview.limit ? ` — as ${state.preview.limit} de maior afinidade recebem o convite.` : "."}
          </p>
          {state.preview.sample.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1">
              {state.preview.sample.map((row) => (
                <li key={row.customerId} className="flex flex-wrap items-baseline gap-2 text-xs text-zinc-700 dark:text-zinc-300">
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">{row.fullName}</span>
                  <span className="rounded bg-zinc-100 px-1.5 py-0.5 dark:bg-zinc-800">{row.score} pts</span>
                  <span>{row.reasons.join(" · ")}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-zinc-500">Ninguém com cartela ou histórico que bata ainda — o quiz em /estilo e as compras alimentam o público.</p>
          )}
        </div>
      ) : null}
    </form>
  );
}

export function ScheduleDropForm({ dropId, problems }: { dropId: string; problems: string[] }) {
  const [state, action] = useActionState(scheduleDropAction, INITIAL);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="dropId" value={dropId} />
      {problems.length > 0 ? (
        <ul className="list-disc pl-5 text-sm text-amber-700 dark:text-amber-400">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Tudo pronto. Ao agendar, as peças ficam escondidas até a publicação e o público é escolhido agora.
        </p>
      )}
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      <div>
        <SubmitButton disabled={problems.length > 0}>Agendar lançamento</SubmitButton>
      </div>
    </form>
  );
}

export function CancelDropForm({ dropId }: { dropId: string }) {
  const [state, action] = useActionState(cancelDropAction, INITIAL);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="dropId" value={dropId} />
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      <div>
        <SubmitButton variant="danger">Cancelar lançamento</SubmitButton>
      </div>
    </form>
  );
}

export function DropStoryForm({ dropId, variant, hasImage }: { dropId: string; variant: "teaser" | "open"; hasImage: boolean }) {
  const [state, action] = useActionState(generateDropStoryAction, INITIAL);
  const label = variant === "teaser" ? "story do véu" : "story aberta";
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="dropId" value={dropId} />
      <input type="hidden" name="variant" value={variant} />
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      <div>
        <SubmitButton variant="outline" size="sm" pendingLabel="Desenhando…">
          {hasImage ? `Gerar ${label} de novo` : `Gerar ${label}`}
        </SubmitButton>
      </div>
    </form>
  );
}
