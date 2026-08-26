"use client";

import Link from "next/link";
import { useActionState } from "react";

import { cx } from "@/components/ui/cx";
import {
  Field,
  FormError,
  FormSuccess,
  Input,
  Select,
  SubmitButton,
} from "@/components/ui/form";
import { AccessResult } from "./access-result";
import {
  createUserAction,
  updateUserAction,
  type FormState,
} from "./actions";

const initialState: FormState = {};

const ROLE_HINT =
  "Proprietário vê tudo: custos, margem, financeiro, relatórios e configurações. " +
  "Funcionário vê pedidos, clientes, produtos, estoque e conversas — sem custo nem margem.";

/** Opção de rádio com título e explicação, usada nos blocos de acesso. */
export function RadioOption({
  name,
  value,
  label,
  hint,
  defaultChecked,
  disabled,
}: {
  name: string;
  value: string;
  label: string;
  hint?: string;
  defaultChecked?: boolean;
  disabled?: boolean;
}) {
  return (
    <label
      className={cx(
        "flex gap-3 rounded-md border p-3",
        disabled
          ? "cursor-not-allowed border-zinc-200 opacity-70 dark:border-zinc-800"
          : "cursor-pointer border-zinc-300 dark:border-zinc-700",
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        defaultChecked={defaultChecked}
        disabled={disabled}
        className="mt-0.5 h-4 w-4 shrink-0 accent-indigo-600"
      />
      <span className="flex flex-col gap-1">
        <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
          {label}
        </span>
        {hint ? (
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            {hint}
          </span>
        ) : null}
      </span>
    </label>
  );
}

export type UserFormInitial = {
  id: string;
  email: string;
  fullName: string;
  role: "owner" | "staff";
};

/**
 * Formulário de usuário do painel. Sem `initial` cadastra alguém novo (e
 * mostra o acesso gerado); com `initial` edita nome e papel.
 *
 * O e-mail só existe no cadastro: ele é a identidade da conta de acesso, e
 * trocá-lo depois é o jeito mais fácil de alguém perder o próprio login.
 */
export function UserForm({
  initial,
  emailConfigured,
}: {
  initial?: UserFormInitial;
  emailConfigured: boolean;
}) {
  const [state, formAction] = useActionState(
    initial ? updateUserAction : createUserAction,
    initialState,
  );

  // Cadastro concluído: a tela vira o acesso gerado. O form some porque
  // reenviar criaria outra pessoa, e o link só aparece uma vez.
  if (!initial && state.access) {
    return (
      <div className="flex flex-col gap-4">
        <AccessResult data={state.access} />
        <div className="flex flex-wrap gap-3 text-sm">
          <Link
            href={`/admin/usuarios/${state.access.userId}`}
            className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
          >
            Ver o cadastro de {state.access.personName}
          </Link>
          <span aria-hidden className="text-zinc-300 dark:text-zinc-700">
            ·
          </span>
          <Link
            href="/admin/usuarios"
            className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
          >
            Voltar para a lista
          </Link>
        </div>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {initial ? (
        <input type="hidden" name="userId" value={initial.id} />
      ) : null}

      <Field label="Nome da pessoa">
        <Input
          name="fullName"
          required
          defaultValue={initial?.fullName}
          placeholder="Ex.: Ana Souza"
        />
      </Field>

      {initial ? (
        <Field
          label="E-mail de acesso"
          hint="Para trocar o e-mail, desative este acesso e cadastre a pessoa de novo."
        >
          <Input value={initial.email} readOnly />
        </Field>
      ) : (
        <Field
          label="E-mail de acesso"
          hint="É com este e-mail que a pessoa entra no painel."
        >
          <Input
            name="email"
            type="email"
            required
            autoComplete="off"
            placeholder="pessoa@email.com"
          />
        </Field>
      )}

      <Field label="O que esta pessoa pode ver" hint={ROLE_HINT}>
        <Select name="role" defaultValue={initial?.role ?? "staff"}>
          <option value="staff">Funcionário</option>
          <option value="owner">Proprietário</option>
        </Select>
      </Field>

      {initial ? null : (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Como a pessoa vai receber o acesso
          </legend>

          <RadioOption
            name="mode"
            value="invite"
            defaultChecked={emailConfigured}
            disabled={!emailConfigured}
            label="Enviar convite por e-mail (a pessoa cria a própria senha)"
            hint="Mostramos o link aqui também, para você copiar se quiser."
          />
          <RadioOption
            name="mode"
            value="password"
            defaultChecked={!emailConfigured}
            label="Definir uma senha provisória"
            hint="Mostramos a senha aqui uma única vez; a pessoa pode trocá-la depois."
          />

          {emailConfigured ? null : (
            <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
              O envio de e-mails ainda não está ligado — use a senha provisória
              ou copie o link do convite. Depois de cadastrar, o link também
              pode ser gerado em “Redefinir senha”, na página da pessoa.
            </p>
          )}
        </fieldset>
      )}

      <FormError message={state.error} />
      <FormSuccess message={state.success} />

      <div>
        <SubmitButton>
          {initial ? "Salvar alterações" : "Cadastrar usuário"}
        </SubmitButton>
      </div>
    </form>
  );
}
