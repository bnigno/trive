"use client";

import { useActionState, useState } from "react";
import {
  Field,
  FormError,
  FormSuccess,
  Input,
  Select,
  SubmitButton,
} from "@/components/ui/form";
import {
  createCouponAction,
  updateCouponAction,
  type FormState,
} from "./actions";

const INITIAL_STATE: FormState = {};

export function CouponCreateForm() {
  const [state, formAction] = useActionState(createCouponAction, INITIAL_STATE);
  const [code, setCode] = useState("");
  const [type, setType] = useState<"percent" | "fixed">("percent");

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          label="Código do cupom"
          hint="É o que o cliente digita no carrinho. Ex.: BEMVINDA10."
        >
          <Input
            name="code"
            required
            maxLength={40}
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            placeholder="BEMVINDA10"
            autoComplete="off"
            className="uppercase"
          />
        </Field>
        <Field
          label="Tipo de desconto"
          hint="Percentual sobre o subtotal ou valor fixo em reais."
        >
          <Select
            name="type"
            value={type}
            onChange={(event) =>
              setType(event.target.value === "fixed" ? "fixed" : "percent")
            }
          >
            <option value="percent">Percentual (%)</option>
            <option value="fixed">Valor fixo (R$)</option>
          </Select>
        </Field>
        {type === "percent" ? (
          <Field
            label="Valor do desconto (%)"
            hint="Número inteiro de 1 a 100. Ex.: 10 = 10% de desconto."
          >
            <Input
              name="value"
              required
              type="number"
              min={1}
              max={100}
              step={1}
              placeholder="10"
            />
          </Field>
        ) : (
          <Field
            label="Valor do desconto (R$)"
            hint="Quanto sai do subtotal. Ex.: 10,00."
          >
            <Input
              name="value"
              required
              inputMode="decimal"
              placeholder="10,00"
            />
          </Field>
        )}
        <Field
          label="Pedido mínimo (R$)"
          hint="O cupom só vale a partir deste subtotal. Deixe vazio para sem mínimo."
        >
          <Input name="minOrder" inputMode="decimal" placeholder="0,00" />
        </Field>
        <Field
          label="Início da vigência (opcional)"
          hint="Antes desta data o cupom ainda não vale. Vazio = vale já."
        >
          <Input name="startsAt" type="datetime-local" />
        </Field>
        <Field
          label="Fim da vigência (opcional)"
          hint="Depois desta data o cupom expira. Vazio = sem validade."
        >
          <Input name="expiresAt" type="datetime-local" />
        </Field>
        <Field
          label="Limite de usos (opcional)"
          hint="Quantos pedidos podem usar o cupom. Vazio = ilimitado."
        >
          <Input
            name="maxUses"
            type="number"
            min={1}
            step={1}
            placeholder="Ilimitado"
          />
        </Field>
      </div>
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      <div>
        <SubmitButton pendingLabel="Criando…">Criar cupom</SubmitButton>
      </div>
    </form>
  );
}

/** Valores já formatados para preencher os inputs (feito no server). */
export type CouponEditDefaults = {
  /** '2026-08-24T15:30' ou '' (sem validade). */
  expiresAt: string;
  /** '100' ou '' (ilimitado). */
  maxUses: string;
};

export function CouponEditForm({
  couponId,
  defaults,
}: {
  couponId: string;
  defaults: CouponEditDefaults;
}) {
  const [state, formAction] = useActionState(updateCouponAction, INITIAL_STATE);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="id" value={couponId} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          label="Fim da vigência"
          hint="Depois desta data o cupom expira. Vazio = sem validade."
        >
          <Input
            name="expiresAt"
            type="datetime-local"
            defaultValue={defaults.expiresAt}
          />
        </Field>
        <Field
          label="Limite de usos"
          hint="Quantos pedidos podem usar o cupom. Vazio = ilimitado."
        >
          <Input
            name="maxUses"
            type="number"
            min={1}
            step={1}
            defaultValue={defaults.maxUses}
            placeholder="Ilimitado"
          />
        </Field>
      </div>
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      <div>
        <SubmitButton pendingLabel="Salvando…">Salvar alterações</SubmitButton>
      </div>
    </form>
  );
}
