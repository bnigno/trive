"use client";

import { UserCheck, UserX } from "lucide-react";
import { useActionState } from "react";

import { ConfirmButton } from "@/components/ui/confirm-button";
import { FormError, FormSuccess } from "@/components/ui/form";
import { iconButtonClassName } from "@/components/ui/icon-button";
import { setUserActiveAction, type FormState } from "./actions";

const initialState: FormState = {};

/**
 * Liga e desliga o acesso. Nunca apagamos: o histórico de quem registrou
 * custo e ajuste de estoque depende da linha continuar existindo.
 * "button" é o bloco da página da pessoa; "icon" é a ação rápida da lista.
 */
export function ToggleActiveForm({
  userId,
  isActive,
  isSelf,
  variant = "button",
}: {
  userId: string;
  isActive: boolean;
  isSelf: boolean;
  variant?: "button" | "icon";
}) {
  const [state, formAction] = useActionState(setUserActiveAction, initialState);
  const selfBlocked = isActive && isSelf;
  const confirmMessage = isActive
    ? "Desativar este acesso? A pessoa é bloqueada no próximo clique e o histórico dela continua guardado."
    : "Ativar este acesso? A pessoa volta a entrar no painel com a senha que já tinha.";
  const label = isActive ? "Desativar acesso" : "Ativar acesso";

  if (variant === "icon") {
    const Icon = isActive ? UserX : UserCheck;
    const title = selfBlocked
      ? "Você não pode desativar o seu próprio acesso"
      : label;
    return (
      <form action={formAction} className="inline-flex flex-col items-end">
        <input type="hidden" name="userId" value={userId} />
        <input type="hidden" name="isActive" value={isActive ? "false" : "true"} />
        <button
          type="submit"
          disabled={selfBlocked}
          aria-label={title}
          title={title}
          onClick={(event) => {
            if (!window.confirm(confirmMessage)) event.preventDefault();
          }}
          className={iconButtonClassName({
            variant: isActive ? "danger" : "ghost",
            size: "sm",
          })}
        >
          <Icon aria-hidden="true" className="size-4" strokeWidth={1.75} />
        </button>
        {state.error ? (
          <span role="alert" className="mt-1 max-w-48 text-right text-[11px] text-red-600 dark:text-red-400">
            {state.error}
          </span>
        ) : null}
      </form>
    );
  }

  if (selfBlocked) {
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
          confirmMessage={confirmMessage}
        >
          {label}
        </ConfirmButton>
      </div>

      <FormError message={state.error} />
      <FormSuccess message={state.success} />
    </form>
  );
}
