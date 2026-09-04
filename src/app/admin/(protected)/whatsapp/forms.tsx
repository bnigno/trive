"use client";

import { useRouter } from "next/navigation";
import { useActionState, useState, useTransition } from "react";

import { Badge } from "@/components/ui/badge";
import { cx } from "@/components/ui/cx";
import {
  Field,
  FormError,
  FormSuccess,
  Input,
  Select,
  SubmitButton,
  TextArea,
} from "@/components/ui/form";
import { renderTemplate } from "@/core/whatsapp/render";
import {
  saveBotSettingsAction,
  saveWaSettingsAction,
  sendTestMessageAction,
  setToggleAction,
  updateWaTemplateAction,
  type FormState,
} from "./actions";
import { PREVIEW_VARIABLES, TEMPLATE_TRIGGERS } from "./template-triggers";

const INITIAL_STATE: FormState = {};

// ---------------------------------------------------------------------------
// Interruptor que salva na hora
// ---------------------------------------------------------------------------

export function ToggleSwitch({
  settingKey,
  checked,
  label,
  hint,
}: {
  settingKey: "wa_enabled" | "bot_enabled";
  checked: boolean;
  label: string;
  hint: string;
}) {
  const router = useRouter();
  const [value, setValue] = useState(checked);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const toggle = () => {
    const next = !value;
    setValue(next);
    setError(null);
    startTransition(async () => {
      const result = await setToggleAction(settingKey, next);
      if ("error" in result) {
        setValue(!next);
        setError(result.error);
        return;
      }
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{label}</p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">{hint}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={value}
          aria-label={label}
          onClick={toggle}
          disabled={isPending}
          className={cx(
            "relative mt-0.5 h-7 w-12 shrink-0 rounded-full p-0 transition-colors disabled:opacity-60 motion-reduce:transition-none",
            value ? "bg-ink-900 dark:bg-ivory-100" : "bg-zinc-300 dark:bg-zinc-700",
          )}
        >
          <span
            aria-hidden="true"
            className={cx(
              "absolute left-0 top-1 h-5 w-5 rounded-full bg-white shadow transition-transform motion-reduce:transition-none dark:bg-ink-900",
              value ? "translate-x-6" : "translate-x-1",
            )}
          />
        </button>
      </div>
      <p aria-live="polite" className="text-[11px] text-zinc-500 dark:text-zinc-400">
        {isPending ? "Salvando…" : ""}
      </p>
      <FormError message={error} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Conexão
// ---------------------------------------------------------------------------

export function WaSettingsForm({
  ownerPhone,
  recoveryAfterMinutes,
}: {
  ownerPhone: string;
  recoveryAfterMinutes: number;
}) {
  const [state, formAction] = useActionState(saveWaSettingsAction, INITIAL_STATE);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          label="Seu WhatsApp (avisos internos)"
          hint="Seu número com DDD — recebe pedidos, estoque baixo e as transferências da vendedora. Vazio = sem avisos."
        >
          <Input
            name="ownerWhatsappPhone"
            inputMode="tel"
            defaultValue={ownerPhone}
            placeholder="(11) 99999-8888"
          />
        </Field>
        <Field
          label="Lembrete de pagamento (minutos)"
          hint="Minutos após o pedido para o ÚNICO lembrete de pagamento. Entre 15 e 720 (12 horas)."
        >
          <Input
            name="recoveryAfterMinutes"
            type="number"
            min={15}
            max={720}
            step={1}
            required
            defaultValue={String(recoveryAfterMinutes)}
          />
        </Field>
      </div>

      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      <div>
        <SubmitButton pendingLabel="Salvando…">Salvar</SubmitButton>
      </div>
    </form>
  );
}

export function SendTestMessageForm() {
  const [state, formAction] = useActionState(sendTestMessageAction, INITIAL_STATE);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      <div>
        <SubmitButton variant="outline" size="sm" pendingLabel="Enviando…">
          Enviar um teste para o meu WhatsApp
        </SubmitButton>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Ficha da vendedora
// ---------------------------------------------------------------------------

export function BotSettingsForm({
  sellerName,
  botModel,
  exchangePolicy,
  botExtraInstructions,
  quickReplies,
}: {
  sellerName: string;
  botModel: string;
  exchangePolicy: string;
  botExtraInstructions: string;
  quickReplies: string;
}) {
  const [state, formAction] = useActionState(
    saveBotSettingsAction,
    INITIAL_STATE,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          label="Nome da vendedora"
          hint="É como ela se apresenta e como aparece nas conversas. Vazio = Lia."
        >
          <Input name="botSellerName" maxLength={40} defaultValue={sellerName} placeholder="Lia" />
        </Field>
        <Field
          label="Inteligência"
          hint="A recomendada vende melhor; a econômica custa menos por conversa. Nos dois casos, uma conversa completa custa centavos de dólar (cobrado pela Anthropic, fora do sistema)."
        >
          <Select name="botModel" defaultValue={botModel}>
            <option value="claude-sonnet-5">Recomendada (Claude Sonnet)</option>
            <option value="claude-haiku-4-5">Econômica (Claude Haiku)</option>
          </Select>
        </Field>
      </div>

      <Field
        label="Política de troca (em uma frase ou duas)"
        hint="Ela responde “posso trocar?” com este texto. Vazio = ela diz que a equipe explica e passa a conversa para você."
      >
        <TextArea
          name="storeExchangePolicy"
          rows={2}
          maxLength={600}
          defaultValue={exchangePolicy}
          placeholder="Ex.: Troca em até 7 dias após a entrega, com etiqueta e sem uso; o frete da troca é por nossa conta na primeira vez."
        />
      </Field>

      <Field
        label="Instruções extras (opcional)"
        hint="Escreva como se orientasse uma vendedora nova: o que destacar, o que evitar, promoções da semana. Preços, estoque e frete ela SEMPRE busca do sistema — instruções não mudam isso."
      >
        <TextArea
          name="botExtraInstructions"
          rows={4}
          maxLength={2000}
          defaultValue={botExtraInstructions}
          placeholder="Ex.: Destaque que a produção é artesanal e que enviamos em até 2 dias úteis."
        />
      </Field>

      <Field
        label="Respostas rápidas suas (uma por linha)"
        hint="Aparecem no botão ⚡ da caixa de mensagem em Conversas, para você responder em um toque."
      >
        <TextArea
          name="waQuickReplies"
          rows={4}
          maxLength={2000}
          defaultValue={quickReplies}
          placeholder={"Oi! Aqui é a equipe da TRIVÉ 🤎 Já estou com a sua conversa.\nUm instante, estou conferindo aqui."}
        />
      </Field>

      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      <div>
        <SubmitButton pendingLabel="Salvando…">Salvar a ficha da vendedora</SubmitButton>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const AVAILABLE_VARIABLES = Object.keys(PREVIEW_VARIABLES);

export function TemplateEditForm({
  templateKey,
  label,
  bodyTemplate,
  isActive,
}: {
  templateKey: string;
  label: string;
  bodyTemplate: string;
  isActive: boolean;
}) {
  const [state, formAction] = useActionState(
    updateWaTemplateAction,
    INITIAL_STATE,
  );
  const [draft, setDraft] = useState(bodyTemplate);
  const trigger = TEMPLATE_TRIGGERS[templateKey];
  const cleanLabel = label.replace(/^\[interno\]\s*/i, "");

  return (
    <details className="group rounded-lg border border-zinc-200 dark:border-zinc-800">
      <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="font-medium text-zinc-900 dark:text-zinc-100">{cleanLabel}</span>
          {trigger ? (
            <span className="text-xs text-zinc-500 dark:text-zinc-400">{trigger}</span>
          ) : null}
        </span>
        {isActive ? (
          <Badge tone="success">Ativa</Badge>
        ) : (
          <Badge tone="neutral">Desligada</Badge>
        )}
      </summary>
      <div className="grid gap-4 border-t border-zinc-200 p-4 md:grid-cols-2 dark:border-zinc-800">
        <form action={formAction} className="flex flex-col gap-4">
          <input type="hidden" name="key" value={templateKey} />

          <Field label="Texto da mensagem">
            <TextArea
              name="bodyTemplate"
              required
              minLength={10}
              rows={6}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          </Field>
          <div className="flex flex-wrap gap-1.5">
            {AVAILABLE_VARIABLES.map((variable) => (
              <button
                key={variable}
                type="button"
                onClick={() => setDraft((current) => `${current}{{${variable}}}`)}
                className="rounded-full border border-zinc-300 px-2 py-0.5 font-mono text-[11px] text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                title={`Inserir {{${variable}}} — ex.: ${PREVIEW_VARIABLES[variable]}`}
              >
                {`{{${variable}}}`}
              </button>
            ))}
          </div>

          <label className="flex items-start gap-2 text-sm text-zinc-700 dark:text-zinc-300">
            <input
              type="checkbox"
              name="isActive"
              defaultChecked={isActive}
              className="mt-0.5 h-4 w-4 rounded border-zinc-300 dark:border-zinc-700"
            />
            <span>
              Mensagem ativa
              <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                Desmarcada, este aviso deixa de ser enviado — os demais
                continuam normalmente.
              </span>
            </span>
          </label>

          <FormError message={state.error} />
          <FormSuccess message={state.success} />
          <div className="flex items-center gap-3">
            <SubmitButton pendingLabel="Salvando…">Salvar mensagem</SubmitButton>
            {draft !== bodyTemplate ? (
              <button
                type="button"
                onClick={() => setDraft(bodyTemplate)}
                className="text-xs text-zinc-500 underline underline-offset-2 dark:text-zinc-400"
              >
                Desfazer
              </button>
            ) : null}
          </div>
        </form>
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            Como a pessoa vai ler
          </p>
          <div className="wa-paper rounded-lg p-4">
            <div className="wa-tail-out relative ml-auto max-w-[92%] rounded-xl rounded-tr-none bg-ink-900 px-3 py-2 text-sm text-ivory-50 shadow-sm dark:bg-ivory-100 dark:text-ink-900">
              <p className="whitespace-pre-wrap break-words">
                {renderTemplate(draft, PREVIEW_VARIABLES) || "…"}
              </p>
              <p className="mt-0.5 text-right text-[11px] text-ivory-300/80 dark:text-ink-500">
                14:32 ✓✓
              </p>
            </div>
          </div>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
            Prévia com dados de exemplo; as variáveis viram o valor real na hora
            do envio.
          </p>
        </div>
      </div>
    </details>
  );
}
