"use client";

import { useActionState } from "react";

import { ConfirmButton } from "@/components/ui/confirm-button";
import { FormError, FormSuccess, SubmitButton } from "@/components/ui/form";
import { AccessResult } from "../access-result";
import {
  resetUserAccessAction,
  setUserActiveAction,
  type FormState,
} from "../actions";
import { RadioOption } from "../user-form";

const initialState: FormState = {};

/**
 * Redefinição de senha feita pelo dono. As duas opções resolvem sem e-mail:
 * o link e a senha aparecem na tela para copiar.
 */
export function ResetAccessForm({
  userId,
  isActive,
  emailConfigured,
}: {
  userId: string;
  isActive: boolean;
  emailConfigured: boolean;
}) {
  const [state, formAction] = useActionState(
    resetUserAccessAction,
    initialState,
  );

  if (!isActive) {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        Este acesso está desativado. Ative o acesso antes de redefinir a senha.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <form action={formAction} className="flex flex-col gap-3">
        <input type="hidden" name="userId" value={userId} />

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Como a pessoa vai receber a nova senha
          </legend>

          <RadioOption
            name="mode"
            value="link"
            defaultChecked
            label="Gerar um link para a pessoa criar a nova senha"
            hint={
              emailConfigured
                ? "Enviamos o link por e-mail e mostramos aqui para você copiar."
                : "O envio de e-mails ainda não está ligado — copie o link e mande pelo WhatsApp."
            }
          />
          <RadioOption
            name="mode"
            value="password"
            label="Definir uma senha provisória"
            hint="Mostramos a senha aqui uma única vez; a pessoa pode trocá-la depois."
          />
        </fieldset>

        <FormError message={state.error} />

        <div>
          <SubmitButton variant="outline" size="sm" pendingLabel="Gerando…">
            Redefinir senha
          </SubmitButton>
        </div>
      </form>

      {state.access ? <AccessResult data={state.access} /> : null}
    </div>
  );
}

/**
 * Liga e desliga o acesso. Nunca apagamos: o histórico de quem registrou
 * custo e ajuste de estoque depende da linha continuar existindo.
 */
export function ToggleActiveForm({
  userId,
  isActive,
  isSelf,
}: {
  userId: string;
  isActive: boolean;
  isSelf: boolean;
}) {
  const [state, formAction] = useActionState(setUserActiveAction, initialState);

  if (isActive && isSelf) {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        Você não pode desativar o seu próprio acesso. Peça para outro
        proprietário fazer isso.
      </p>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="isActive" value={isActive ? "false" : "true"} />

      <div>
        <ConfirmButton
          size="sm"
          variant={isActive ? "danger" : "primary"}
          confirmMessage={
            isActive
              ? "Desativar este acesso? A pessoa é bloqueada no próximo clique e o histórico dela continua guardado."
              : "Ativar este acesso? A pessoa volta a entrar no painel com a senha que já tinha."
          }
        >
          {isActive ? "Desativar acesso" : "Ativar acesso"}
        </ConfirmButton>
      </div>

      <FormError message={state.error} />
      <FormSuccess message={state.success} />
    </form>
  );
}
