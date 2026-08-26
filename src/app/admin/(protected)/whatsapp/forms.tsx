"use client";

import { useActionState } from "react";

import { Badge } from "@/components/ui/badge";
import {
  Field,
  FormError,
  FormSuccess,
  Input,
  Select,
  SubmitButton,
  TextArea,
} from "@/components/ui/form";
import {
  saveBotSettingsAction,
  saveWaSettingsAction,
  sendTestMessageAction,
  updateWaTemplateAction,
  type FormState,
} from "./actions";

const INITIAL_STATE: FormState = {};

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------

export function WaSettingsForm({
  waEnabled,
  ownerPhone,
  recoveryAfterMinutes,
}: {
  waEnabled: boolean;
  ownerPhone: string;
  recoveryAfterMinutes: number;
}) {
  const [state, formAction] = useActionState(saveWaSettingsAction, INITIAL_STATE);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <label className="flex items-start gap-2 text-sm text-zinc-700 dark:text-zinc-300">
        <input
          type="checkbox"
          name="waEnabled"
          defaultChecked={waEnabled}
          className="mt-0.5 h-4 w-4 rounded border-zinc-300 dark:border-zinc-700"
        />
        <span>
          Enviar mensagens automáticas pelo WhatsApp
          <span className="block text-xs text-zinc-500 dark:text-zinc-400">
            Sem credenciais Z-API configuradas na hospedagem, o modo simulado
            atende só testes — nenhuma mensagem real sai para clientes.
          </span>
        </span>
      </label>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          label="Seu WhatsApp (avisos internos)"
          hint="Seu número com DDD — recebe avisos de pedidos, estoque baixo e respostas de clientes. Deixe vazio para não receber."
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
          hint="Minutos após o pedido para enviar o ÚNICO lembrete de pagamento. Entre 15 e 720 (12 horas)."
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
        <SubmitButton pendingLabel="Salvando…">Salvar configurações</SubmitButton>
      </div>
    </form>
  );
}

export function BotSettingsForm({
  botEnabled,
  botModel,
  botExtraInstructions,
}: {
  botEnabled: boolean;
  botModel: string;
  botExtraInstructions: string;
}) {
  const [state, formAction] = useActionState(
    saveBotSettingsAction,
    INITIAL_STATE,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <label className="flex items-start gap-2 text-sm text-zinc-700 dark:text-zinc-300">
        <input
          type="checkbox"
          name="botEnabled"
          defaultChecked={botEnabled}
          className="mt-0.5 h-4 w-4 rounded border-zinc-300 dark:border-zinc-700"
        />
        <span>
          Deixar o robô vender sozinho no WhatsApp da loja
          <span className="block text-xs text-zinc-500 dark:text-zinc-400">
            Ligado, a IA apresenta os produtos, calcula o frete, monta o pedido
            e envia o link de pagamento — tudo registrado nas conversas e nos
            pedidos. Desligado, as mensagens dos clientes continuam chegando no
            seu WhatsApp como hoje.
          </span>
        </span>
      </label>

      <Field
        label="Modelo de IA"
        hint="O modelo recomendado vende melhor; o econômico custa menos por conversa. Nos dois casos, uma conversa completa custa centavos (cobrado pela Anthropic, fora do sistema)."
      >
        <Select name="botModel" defaultValue={botModel}>
          <option value="claude-sonnet-5">
            Recomendado — vendedor mais habilidoso (Claude Sonnet)
          </option>
          <option value="claude-haiku-4-5">
            Econômico — mais simples e mais barato (Claude Haiku)
          </option>
        </Select>
      </Field>

      <Field
        label="Instruções extras para o robô (opcional)"
        hint="Escreva como se orientasse um vendedor novo: tom de voz, o que destacar, o que evitar. Ex.: “Trate os clientes por você. Destaque que a produção é artesanal. Prazo de produção: até 3 dias úteis antes do envio.” Preços, estoque e frete ele SEMPRE busca do sistema — instruções não mudam isso."
      >
        <TextArea
          name="botExtraInstructions"
          rows={4}
          maxLength={2000}
          defaultValue={botExtraInstructions}
          placeholder="Ex.: Seja simpático e direto. Sugira o produto mais vendido quando o cliente estiver em dúvida."
        />
      </Field>

      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      <div>
        <SubmitButton pendingLabel="Salvando…">Salvar vendedor com IA</SubmitButton>
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
        <SubmitButton variant="outline" pendingLabel="Enviando…">
          Enviar mensagem de teste para mim
        </SubmitButton>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const AVAILABLE_VARIABLES =
  "{{nome}}, {{cliente}}, {{pedido}}, {{total}}, {{link}}, {{prazo}}, {{rastreio}}, {{metodo}}, {{produto}}, {{sku}}, {{disponivel}} e {{loja}}";

export function TemplateEditForm({
  templateKey,
  label,
  bodyTemplate,
  isActive,
  isInternal,
}: {
  templateKey: string;
  label: string;
  bodyTemplate: string;
  isActive: boolean;
  isInternal: boolean;
}) {
  const [state, formAction] = useActionState(
    updateWaTemplateAction,
    INITIAL_STATE,
  );

  return (
    <details className="rounded-lg border border-zinc-200 dark:border-zinc-800">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-4 py-3 text-sm font-medium text-zinc-800 dark:text-zinc-200">
        <span>{label}</span>
        {isInternal ? <Badge tone="neutral">Aviso interno</Badge> : null}
        {isActive ? (
          <Badge tone="success">Ativa</Badge>
        ) : (
          <Badge tone="neutral">Inativa</Badge>
        )}
      </summary>
      <div className="border-t border-zinc-200 p-4 dark:border-zinc-800">
        <form action={formAction} className="flex flex-col gap-4">
          <input type="hidden" name="key" value={templateKey} />

          <Field
            label="Texto da mensagem"
            hint={`Variáveis disponíveis: ${AVAILABLE_VARIABLES} — elas viram o valor real na hora do envio (ex.: {{nome}} vira o nome do cliente).`}
          >
            <TextArea
              name="bodyTemplate"
              required
              minLength={10}
              rows={5}
              defaultValue={bodyTemplate}
            />
          </Field>

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
          <div>
            <SubmitButton pendingLabel="Salvando…">Salvar mensagem</SubmitButton>
          </div>
        </form>
      </div>
    </details>
  );
}
