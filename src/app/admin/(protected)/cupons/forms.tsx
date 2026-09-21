"use client";

import { useActionState, useState } from "react";
import {
  Field,
  FormError,
  FormSuccess,
  Input,
  Select,
  SubmitButton,
  TextArea,
} from "@/components/ui/form";
import { WEEKDAY_OPTIONS } from "@/lib/coupon-fields";
import {
  createCouponAction,
  deleteCouponAction,
  updateCouponAction,
  type FormState,
} from "./actions";

const INITIAL_STATE: FormState = {};

export type CouponType = "percent" | "fixed" | "free_shipping";
export type CouponCategoryOption = { id: string; name: string };

/** Valores já formatados para preencher os inputs (feito no server). */
export type CouponFormDefaults = {
  type: CouponType;
  /** "10" (percent) ou "24,90" (fixed); "" no frete grátis. */
  value: string;
  minOrder: string;
  /** '2026-08-24T15:30' ou ''. */
  startsAt: string;
  expiresAt: string;
  maxUses: string;
  perCustomerLimit: string;
  customerPhone: string;
  firstPurchaseOnly: boolean;
  freeShippingScope: "any" | "motoboy" | "correios";
  weekdays: number[];
  /** "14:00" ou "". */
  validFrom: string;
  validTo: string;
  /** SKU/slug, um por linha. */
  productRefs: string;
  categoryIds: string[];
  note: string;
  /** Degraus do cupom que muda com o tempo: até 3 pares (dia, valor como a dona digita). */
  steps: { afterDays: string; value: string }[];
  /** Cupom da turma: quanto sobe por amiga e o teto (como a dona digita). */
  growthPerRedeemer: string;
  growthCap: string;
};

export const EMPTY_COUPON_DEFAULTS: CouponFormDefaults = {
  type: "percent",
  value: "",
  minOrder: "",
  startsAt: "",
  expiresAt: "",
  maxUses: "",
  perCustomerLimit: "",
  customerPhone: "",
  firstPurchaseOnly: false,
  freeShippingScope: "any",
  weekdays: [],
  validFrom: "",
  validTo: "",
  productRefs: "",
  categoryIds: [],
  note: "",
  steps: [],
  growthPerRedeemer: "",
  growthCap: "",
};

const checkboxClasses =
  "h-4 w-4 rounded border-zinc-300 text-indigo-600 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-900";

/** Os campos de regra do cupom, iguais no criar e no editar (quando ninguém usou). */
function CouponRuleFields({
  defaults,
  categories,
}: {
  defaults: CouponFormDefaults;
  categories: CouponCategoryOption[];
}) {
  const [type, setType] = useState<CouponType>(defaults.type);

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          label="Tipo de desconto"
          hint="Percentual sobre as peças, valor fixo em reais ou frete grátis."
        >
          <Select
            name="type"
            value={type}
            onChange={(event) => setType(event.target.value as CouponType)}
          >
            <option value="percent">Percentual (%)</option>
            <option value="fixed">Valor fixo (R$)</option>
            <option value="free_shipping">Frete grátis</option>
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
              defaultValue={defaults.type === "percent" ? defaults.value : ""}
              placeholder="10"
            />
          </Field>
        ) : type === "fixed" ? (
          <Field
            label="Valor do desconto (R$)"
            hint="Quanto sai do subtotal. Ex.: 10,00."
          >
            <Input
              name="value"
              required
              inputMode="decimal"
              defaultValue={defaults.type === "fixed" ? defaults.value : ""}
              placeholder="10,00"
            />
          </Field>
        ) : (
          <Field
            label="Frete grátis para"
            hint="Qualquer entrega, só o motoboy ou só os Correios."
          >
            <Select name="freeShippingScope" defaultValue={defaults.freeShippingScope}>
              <option value="any">Qualquer entrega</option>
              <option value="motoboy">Só motoboy</option>
              <option value="correios">Só Correios</option>
            </Select>
          </Field>
        )}
        <Field
          label="Pedido mínimo (R$)"
          hint="O cupom só vale a partir deste subtotal. Deixe vazio para sem mínimo."
        >
          <Input name="minOrder" inputMode="decimal" defaultValue={defaults.minOrder} placeholder="0,00" />
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
            defaultValue={defaults.maxUses}
            placeholder="Ilimitado"
          />
        </Field>
        <Field
          label="Início da vigência (opcional)"
          hint="Antes desta data o cupom ainda não vale. Vazio = vale já."
        >
          <Input name="startsAt" type="datetime-local" defaultValue={defaults.startsAt} />
        </Field>
        <Field
          label="Fim da vigência (opcional)"
          hint="Depois desta data o cupom expira. Vazio = sem validade."
        >
          <Input name="expiresAt" type="datetime-local" defaultValue={defaults.expiresAt} />
        </Field>
      </div>

      <details className="rounded-lg border border-zinc-200 dark:border-zinc-800" open={hasAdvancedRules(defaults)}>
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-zinc-800 dark:text-zinc-200">
          Regras (opcional): por cliente, peças, dia e horário
        </summary>
        <div className="grid grid-cols-1 gap-4 border-t border-zinc-200 p-4 sm:grid-cols-2 dark:border-zinc-800">
          <Field
            label="Limite por cliente"
            hint="Quantas vezes a MESMA cliente (CPF/telefone) pode usar. Vazio = sem limite; 1 = uma vez."
          >
            <Input
              name="perCustomerLimit"
              type="number"
              min={1}
              step={1}
              defaultValue={defaults.perCustomerLimit}
              placeholder="Sem limite"
            />
          </Field>
          <Field
            label="Só para esta cliente (telefone)"
            hint="Cupom pessoal: só quem tem este telefone (ou o cadastro dele) usa. Vazio = qualquer cliente."
          >
            <Input
              name="customerPhone"
              inputMode="tel"
              defaultValue={defaults.customerPhone}
              placeholder="(91) 99999-0000"
              autoComplete="off"
            />
          </Field>
          <label className="flex items-center gap-2 text-sm text-zinc-700 sm:col-span-2 dark:text-zinc-300">
            <input
              type="checkbox"
              name="firstPurchaseOnly"
              defaultChecked={defaults.firstPurchaseOnly}
              className={checkboxClasses}
            />
            <span>
              Só para a primeira compra
              <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                Quem já tem pedido pago (ou aguardando Pix) não usa. Combine com limite por cliente = 1.
              </span>
            </span>
          </label>
          <Field
            label="Só para estas peças"
            hint="SKU ou slug, um por linha. O desconto incide só sobre elas; as outras peças da sacola seguem cheias."
            className="sm:col-span-2"
          >
            <TextArea name="productRefs" rows={3} defaultValue={defaults.productRefs} placeholder={"LONGO-DUNAS-AREIA-M\nblusa-maelle"} />
          </Field>
          {categories.length > 0 ? (
            <fieldset className="flex flex-col gap-1.5 text-sm sm:col-span-2">
              <legend className="font-medium text-zinc-700 dark:text-zinc-300">Só para estas categorias</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {categories.map((category) => (
                  <label key={category.id} className="flex items-center gap-2 text-zinc-700 dark:text-zinc-300">
                    <input
                      type="checkbox"
                      name="categoryIds"
                      value={category.id}
                      defaultChecked={defaults.categoryIds.includes(category.id)}
                      className={checkboxClasses}
                    />
                    {category.name}
                  </label>
                ))}
              </div>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                Só a categoria direta da peça conta: marque também as subcategorias.
              </span>
            </fieldset>
          ) : null}
          <fieldset className="flex flex-col gap-1.5 text-sm sm:col-span-2">
            <legend className="font-medium text-zinc-700 dark:text-zinc-300">Dias da semana</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {WEEKDAY_OPTIONS.map((day) => (
                <label key={day.value} className="flex items-center gap-2 text-zinc-700 dark:text-zinc-300">
                  <input
                    type="checkbox"
                    name="weekdays"
                    value={day.value}
                    defaultChecked={defaults.weekdays.includes(day.value)}
                    className={checkboxClasses}
                  />
                  {day.label}
                </label>
              ))}
            </div>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">Nenhum marcado = vale todo dia.</span>
          </fieldset>
          <Field
            label="Horário de início"
            hint="Relógio de Belém. Ex.: a chuva das duas = 14:00 a 15:00."
          >
            <Input name="validFrom" type="time" defaultValue={defaults.validFrom} />
          </Field>
          <Field label="Horário de fim" hint="Vazio nos dois = o dia todo.">
            <Input name="validTo" type="time" defaultValue={defaults.validTo} />
          </Field>
          <Field
            label="Nota interna"
            hint="Só a equipe vê. Ex.: story de 20/09, campanha do Círio."
            className="sm:col-span-2"
          >
            <Input name="note" maxLength={500} defaultValue={defaults.note} />
          </Field>
        </div>
      </details>

      {type !== "free_shipping" ? (
        <details className="rounded-lg border border-zinc-200 dark:border-zinc-800" open={defaults.growthPerRedeemer !== ""}>
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-zinc-800 dark:text-zinc-200">
            Cupom da turma (opcional)
          </summary>
          <div className="flex flex-col gap-4 border-t border-zinc-200 p-4 dark:border-zinc-800">
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              O valor acima é o inicial. Cada cliente distinta (CPF/telefone) que usar sobe o desconto para as próximas, até o
              teto — feito para circular no grupo de WhatsApp: quem compartilha melhora o cupom de todo mundo. A sacola ganha o
              botão “Mandar para uma amiga”. Não combina com os degraus por tempo.
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label={type === "percent" ? "Sobe por amiga (pontos)" : "Sobe por amiga (R$)"} hint="Vazio = cupom comum.">
                <Input name="growthPerRedeemer" inputMode="decimal" defaultValue={defaults.growthPerRedeemer} placeholder={type === "percent" ? "2" : "5,00"} />
              </Field>
              <Field label={type === "percent" ? "Teto (%)" : "Teto (R$)"} hint="Obrigatório quando sobe.">
                <Input name="growthCap" inputMode="decimal" defaultValue={defaults.growthCap} placeholder={type === "percent" ? "15" : "30,00"} />
              </Field>
            </div>
          </div>
        </details>
      ) : null}

      {type !== "free_shipping" ? (
        <details className="rounded-lg border border-zinc-200 dark:border-zinc-800" open={defaults.steps.length > 0}>
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-zinc-800 dark:text-zinc-200">
            Cupom que muda com o tempo (opcional)
          </summary>
          <div className="flex flex-col gap-4 border-t border-zinc-200 p-4 dark:border-zinc-800">
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              O valor acima é o do dia 0. Os degraus contam desde o início da vigência (ou da criação). Ex.: dia 7 → 10%, dia 30
              → 15% — o cupom que amadurece (“espero subir ou a peça acaba?”). Para um cupom que derrete, use valores decrescentes.
              A cliente vê “Hoje vale 10%. Em 9 dias passa a 15%, se a peça ainda estiver aqui.”
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {[0, 1, 2].map((index) => (
                <div key={index} className="flex flex-col gap-3 rounded-md border border-zinc-100 p-3 dark:border-zinc-800">
                  <Field label={`Degrau ${index + 2} — a partir do dia`}>
                    <Input
                      name={`step${index}Days`}
                      type="number"
                      min={1}
                      max={365}
                      step={1}
                      defaultValue={defaults.steps[index]?.afterDays ?? ""}
                      placeholder={index === 0 ? "7" : index === 1 ? "30" : ""}
                    />
                  </Field>
                  <Field label={type === "percent" ? "passa a valer (%)" : "passa a valer (R$)"}>
                    <Input
                      name={`step${index}Value`}
                      inputMode="decimal"
                      defaultValue={defaults.steps[index]?.value ?? ""}
                      placeholder={type === "percent" ? (index === 0 ? "10" : index === 1 ? "15" : "") : "20,00"}
                    />
                  </Field>
                </div>
              ))}
            </div>
          </div>
        </details>
      ) : null}
    </>
  );
}

function hasAdvancedRules(defaults: CouponFormDefaults): boolean {
  return (
    defaults.perCustomerLimit !== "" ||
    defaults.customerPhone !== "" ||
    defaults.firstPurchaseOnly ||
    defaults.productRefs !== "" ||
    defaults.categoryIds.length > 0 ||
    defaults.weekdays.length > 0 ||
    defaults.validFrom !== "" ||
    defaults.note !== ""
  );
}

export function CouponCreateForm({ categories }: { categories: CouponCategoryOption[] }) {
  const [state, formAction] = useActionState(createCouponAction, INITIAL_STATE);
  const [code, setCode] = useState("");

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          label="Código do cupom"
          hint="É o que a cliente digita na sacola (ou recebe no link /c/CÓDIGO). Ex.: BEMVINDA10."
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
      </div>
      <CouponRuleFields defaults={EMPTY_COUPON_DEFAULTS} categories={categories} />
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      <div>
        <SubmitButton pendingLabel="Criando…">Criar cupom</SubmitButton>
      </div>
    </form>
  );
}

export function CouponEditForm({
  couponId,
  defaults,
  categories,
  locked,
}: {
  couponId: string;
  defaults: CouponFormDefaults;
  categories: CouponCategoryOption[];
  /** Já usado: só vigência, limite de usos e nota mudam. */
  locked: boolean;
}) {
  const [state, formAction] = useActionState(updateCouponAction, INITIAL_STATE);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="id" value={couponId} />
      <input type="hidden" name="mode" value={locked ? "limited" : "full"} />
      {locked ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label="Fim da vigência"
            hint="Depois desta data o cupom expira. Vazio = sem validade."
          >
            <Input name="expiresAt" type="datetime-local" defaultValue={defaults.expiresAt} />
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
          <Field label="Nota interna" hint="Só a equipe vê." className="sm:col-span-2">
            <Input name="note" maxLength={500} defaultValue={defaults.note} />
          </Field>
        </div>
      ) : (
        <CouponRuleFields defaults={defaults} categories={categories} />
      )}
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      <div>
        <SubmitButton pendingLabel="Salvando…">Salvar alterações</SubmitButton>
      </div>
    </form>
  );
}

export function CouponDeleteForm({ couponId, code }: { couponId: string; code: string }) {
  const [state, formAction] = useActionState(deleteCouponAction, INITIAL_STATE);

  return (
    <form
      action={formAction}
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        if (!window.confirm(`Excluir o cupom ${code}? Ninguém usou; não dá para desfazer.`)) event.preventDefault();
      }}
    >
      <input type="hidden" name="id" value={couponId} />
      <SubmitButton pendingLabel="Excluindo…" variant="outline" size="sm">
        Excluir
      </SubmitButton>
      <FormError message={state.error} />
    </form>
  );
}
