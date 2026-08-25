"use client";

import Link from "next/link";
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
  replaceFeeRuleAction,
  updateApprovalRulesAction,
  updatePolicyAction,
  updateStockSettingsAction,
  updateStoreDataAction,
  type FormState,
} from "./actions";

const INITIAL_STATE: FormState = {};

/** 0.0498 -> '4,98' (para preencher inputs de percentual). */
function rateToInput(rate: number): string {
  return ((rate * 10000) / 100).toLocaleString("pt-BR", {
    maximumFractionDigits: 2,
  });
}

/** 250 -> '2,50' (para preencher inputs de dinheiro). */
function centsToInput(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// ---------------------------------------------------------------------------
// Dados da loja (rodapé e páginas legais)
// ---------------------------------------------------------------------------

/** Máscara progressiva de CNPJ: '11222333000181' -> '11.222.333/0001-81'. */
function maskCnpj(raw: string): string {
  const d = raw.replace(/\D/g, "").slice(0, 14);
  let out = d.slice(0, 2);
  if (d.length > 2) out += `.${d.slice(2, 5)}`;
  if (d.length > 5) out += `.${d.slice(5, 8)}`;
  if (d.length > 8) out += `/${d.slice(8, 12)}`;
  if (d.length > 12) out += `-${d.slice(12, 14)}`;
  return out;
}

export function StoreDataForm({
  defaults,
}: {
  defaults: {
    name: string;
    cnpj: string;
    address: string;
    email: string;
    whatsapp: string;
  };
}) {
  const [state, formAction] = useActionState(updateStoreDataAction, INITIAL_STATE);
  const [cnpj, setCnpj] = useState(maskCnpj(defaults.cnpj));

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          label="Nome da loja"
          hint="Aparece no cabeçalho, no rodapé e nos e-mails da loja."
        >
          <Input
            name="storeName"
            maxLength={120}
            defaultValue={defaults.name}
            placeholder="TRIVË"
          />
        </Field>
        <Field
          label="CNPJ"
          hint="Obrigatório para vender online (Decreto 7.962/2013)."
        >
          <Input
            name="storeCnpj"
            inputMode="numeric"
            value={cnpj}
            onChange={(event) => setCnpj(maskCnpj(event.target.value))}
            placeholder="00.000.000/0000-00"
          />
        </Field>
        <Field
          label="Endereço da loja"
          hint="Endereço físico completo, com cidade, UF e CEP."
          className="sm:col-span-2"
        >
          <Input
            name="storeAddress"
            maxLength={300}
            defaultValue={defaults.address}
            placeholder="Rua Exemplo, 123 — Centro, São Paulo/SP, 01000-000"
          />
        </Field>
        <Field
          label="E-mail de contato"
          hint="Canal de atendimento exibido nas páginas legais."
        >
          <Input
            name="storeEmail"
            type="email"
            maxLength={200}
            defaultValue={defaults.email}
            placeholder="contato@sualoja.com.br"
          />
        </Field>
        <Field
          label="WhatsApp"
          hint="Número com DDD que receberá os clientes. Ex.: (11) 99999-8888."
        >
          <Input
            name="storeWhatsapp"
            inputMode="tel"
            defaultValue={defaults.whatsapp}
            placeholder="(11) 99999-8888"
          />
        </Field>
      </div>

      <FormError message={state.error} />
      <FormSuccess message={state.success} />

      <div>
        <SubmitButton pendingLabel="Salvando…">Salvar dados da loja</SubmitButton>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Nova vigência de taxa (por método de pagamento)
// ---------------------------------------------------------------------------

export function FeeRuleForm({
  paymentMethod,
  methodLabel,
  defaults,
}: {
  paymentMethod: string;
  methodLabel: string;
  defaults: {
    percentRate: number;
    fixedFeeCents: number;
    settlementDays: number;
    installmentsMax: number;
    isReferenceForPricing: boolean;
  } | null;
}) {
  const [state, formAction] = useActionState(replaceFeeRuleAction, INITIAL_STATE);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="paymentMethod" value={paymentMethod} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          label="Taxa percentual (%)"
          hint="Quanto o Mercado Pago desconta de cada venda, em %. Ex.: 4,98"
        >
          <Input
            name="percent"
            inputMode="decimal"
            required
            defaultValue={defaults ? rateToInput(defaults.percentRate) : ""}
            placeholder="4,98"
          />
        </Field>
        <Field
          label="Tarifa fixa (R$)"
          hint="Valor fixo cobrado por venda, se houver. Ex.: 0,60"
        >
          <Input
            name="fixedFee"
            inputMode="decimal"
            defaultValue={defaults ? centsToInput(defaults.fixedFeeCents) : "0,00"}
            placeholder="0,00"
          />
        </Field>
        <Field
          label="Prazo de repasse (dias)"
          hint="Em quantos dias o dinheiro desta venda cai na sua conta."
        >
          <Input
            name="settlementDays"
            type="number"
            min={0}
            step={1}
            required
            defaultValue={defaults ? String(defaults.settlementDays) : "0"}
          />
        </Field>
        <Field
          label="Parcelas (máximo)"
          hint="Número máximo de parcelas que esta taxa cobre. Use 1 para à vista."
        >
          <Input
            name="installmentsMax"
            type="number"
            min={1}
            step={1}
            defaultValue={defaults ? String(defaults.installmentsMax) : "1"}
          />
        </Field>
      </div>

      <label className="flex items-start gap-2 text-sm text-zinc-700 dark:text-zinc-300">
        <input
          type="checkbox"
          name="isReference"
          defaultChecked={defaults?.isReferenceForPricing ?? false}
          className="mt-0.5 h-4 w-4 rounded border-zinc-300 dark:border-zinc-700"
        />
        <span>
          Usar esta taxa como referência para calcular preços
          <span className="block text-xs text-zinc-500 dark:text-zinc-400">
            Só um método pode ser a referência — marcar aqui desmarca o outro.
          </span>
        </span>
      </label>

      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      {state.success ? (
        <p className="rounded-md border border-indigo-300 bg-indigo-50 px-3 py-2 text-sm text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-300">
          A nova taxa vale para os próximos cálculos.{" "}
          <Link href="/admin/precos" className="font-medium underline">
            Recalcular preços agora
          </Link>
        </p>
      ) : null}

      <div>
        <SubmitButton pendingLabel="Salvando…">
          Salvar nova vigência — {methodLabel}
        </SubmitButton>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Política de precificação
// ---------------------------------------------------------------------------

export function PolicyForm({
  defaults,
}: {
  defaults: {
    targetMarginRate: number;
    minMarginRate: number;
    roundingMode: string;
    roundingDirection: string;
    otherCostsFixedCents: number;
  } | null;
}) {
  const [state, formAction] = useActionState(updatePolicyAction, INITIAL_STATE);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          label="Margem alvo (%)"
          hint="Quanto você quer ganhar em cada venda, depois de custos e taxas. Ex.: 30"
        >
          <Input
            name="targetMargin"
            inputMode="decimal"
            required
            defaultValue={defaults ? rateToInput(defaults.targetMarginRate) : "30"}
            placeholder="30"
          />
        </Field>
        <Field
          label="Margem mínima (%)"
          hint="Abaixo desta margem, o preço só entra com a sua aprovação."
        >
          <Input
            name="minMargin"
            inputMode="decimal"
            required
            defaultValue={defaults ? rateToInput(defaults.minMarginRate) : "15"}
            placeholder="15"
          />
        </Field>
        <Field
          label="Arredondamento"
          hint="Deixa o preço mais bonito no final do cálculo. Ex.: R$ 15,38 vira R$ 16,90."
        >
          <Select
            name="roundingMode"
            defaultValue={defaults?.roundingMode ?? "to_90"}
          >
            <option value="none">Sem arredondamento</option>
            <option value="to_90">Terminar em ,90</option>
            <option value="to_99">Terminar em ,99</option>
            <option value="to_50">Terminar em ,50</option>
            <option value="integer">Valor cheio (sem centavos)</option>
          </Select>
        </Field>
        <Field
          label="Direção do arredondamento"
          hint="Para cima nunca reduz o preço; mais próximo pode reduzir alguns centavos."
        >
          <Select
            name="roundingDirection"
            defaultValue={defaults?.roundingDirection ?? "up"}
          >
            <option value="up">Sempre para cima</option>
            <option value="nearest">Mais próximo</option>
          </Select>
        </Field>
        <Field
          label="Custos fixos por venda (R$)"
          hint="Embalagem, etiqueta, brinde… somados ao custo em cada cálculo. Ex.: 2,50"
        >
          <Input
            name="otherCostsFixed"
            inputMode="decimal"
            defaultValue={
              defaults ? centsToInput(defaults.otherCostsFixedCents) : "0,00"
            }
            placeholder="0,00"
          />
        </Field>
      </div>

      <FormError message={state.error} />
      <FormSuccess message={state.success} />

      <div>
        <SubmitButton pendingLabel="Salvando…">Salvar política</SubmitButton>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Regras de aprovação
// ---------------------------------------------------------------------------

export function ApprovalRulesForm({
  defaults,
}: {
  defaults: { changeThresholdRate: number; firstPriceRequiresApproval: boolean };
}) {
  const [state, formAction] = useActionState(
    updateApprovalRulesAction,
    INITIAL_STATE,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <Field
        label="Limite de variação de preço (%)"
        hint="Mudanças de preço maiores que este percentual só entram com a sua aprovação. Ex.: 10"
        className="sm:max-w-xs"
      >
        <Input
          name="changeThreshold"
          inputMode="decimal"
          required
          defaultValue={rateToInput(defaults.changeThresholdRate)}
          placeholder="10"
        />
      </Field>

      <label className="flex items-start gap-2 text-sm text-zinc-700 dark:text-zinc-300">
        <input
          type="checkbox"
          name="firstPriceRequiresApproval"
          defaultChecked={defaults.firstPriceRequiresApproval}
          className="mt-0.5 h-4 w-4 rounded border-zinc-300 dark:border-zinc-700"
        />
        <span>
          Primeira precificação exige aprovação
          <span className="block text-xs text-zinc-500 dark:text-zinc-400">
            O primeiro preço de cada produto passa por você antes de valer.
          </span>
        </span>
      </label>

      <FormError message={state.error} />
      <FormSuccess message={state.success} />

      <div>
        <SubmitButton pendingLabel="Salvando…">Salvar regras</SubmitButton>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Estoque
// ---------------------------------------------------------------------------

export function StockSettingsForm({
  defaults,
}: {
  defaults: { lowStockThreshold: number; reservationTtlMinutes: number };
}) {
  const [state, formAction] = useActionState(
    updateStockSettingsAction,
    INITIAL_STATE,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          label="Limiar padrão de alerta de estoque"
          hint="Quando o disponível chega neste número (ou menos), a variação aparece como estoque baixo."
        >
          <Input
            name="lowStockThreshold"
            type="number"
            min={0}
            step={1}
            required
            defaultValue={String(defaults.lowStockThreshold)}
          />
        </Field>
        <Field
          label="Tempo de reserva (minutos)"
          hint="Por quanto tempo um pedido não pago segura o estoque reservado."
        >
          <Input
            name="reservationTtlMinutes"
            type="number"
            min={1}
            step={1}
            required
            defaultValue={String(defaults.reservationTtlMinutes)}
          />
        </Field>
      </div>

      <FormError message={state.error} />
      <FormSuccess message={state.success} />

      <div>
        <SubmitButton pendingLabel="Salvando…">Salvar estoque</SubmitButton>
      </div>
    </form>
  );
}
