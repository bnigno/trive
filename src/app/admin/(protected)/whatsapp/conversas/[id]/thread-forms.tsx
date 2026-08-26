"use client";

import { useActionState } from "react";

import {
  FormError,
  FormSuccess,
  SubmitButton,
  TextArea,
} from "@/components/ui/form";
import {
  returnConversationToBotAction,
  sendManualReplyAction,
  takeOverConversationAction,
  type FormState,
} from "./actions";

const INITIAL_STATE: FormState = {};

export function TakeOverForm({ conversationId }: { conversationId: string }) {
  const [state, formAction] = useActionState(
    takeOverConversationAction,
    INITIAL_STATE,
  );

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="conversationId" value={conversationId} />
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      <div>
        <SubmitButton variant="outline" pendingLabel="Assumindo…">
          Assumir conversa
        </SubmitButton>
      </div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        O robô para de responder e as mensagens do cliente passam a chegar no
        seu WhatsApp.
      </p>
    </form>
  );
}

export function ReturnToBotForm({ conversationId }: { conversationId: string }) {
  const [state, formAction] = useActionState(
    returnConversationToBotAction,
    INITIAL_STATE,
  );

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="conversationId" value={conversationId} />
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      <div>
        <SubmitButton variant="outline" pendingLabel="Devolvendo…">
          Devolver ao robô
        </SubmitButton>
      </div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        A IA volta a responder sozinha na próxima mensagem do cliente.
      </p>
    </form>
  );
}

export function ManualReplyForm({ conversationId }: { conversationId: string }) {
  const [state, formAction] = useActionState(
    sendManualReplyAction,
    INITIAL_STATE,
  );

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="conversationId" value={conversationId} />
      <TextArea
        name="body"
        required
        minLength={1}
        maxLength={4000}
        rows={3}
        placeholder="Escreva sua resposta para o cliente…"
      />
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      <div className="flex items-center gap-3">
        <SubmitButton pendingLabel="Enviando…">Enviar resposta</SubmitButton>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          Responder assume a conversa para você automaticamente.
        </span>
      </div>
    </form>
  );
}
