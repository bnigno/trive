"use client";

import { useActionState, useState } from "react";

import { Button, Field, FormError, FormSuccess, Input, Select, SubmitButton, TextArea } from "@/components/ui/form";

import { composePostAction, registerGroupAction, saveWelcomeGiftAction, type FormState } from "./actions";

const INITIAL_STATE: FormState = {};

export type ProviderGroupOption = { groupId: string; name: string | null; registeredId: string | null };

/** Texto de várias linhas com "Copiar" (o CopyField é de uma linha só: um input não mostra quebras). */
export function CopyBlock({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "manual">("idle");
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{label}</span>
      <pre className="whitespace-pre-wrap rounded-md border border-zinc-300 bg-zinc-50 px-3 py-2 font-sans text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100">{value}</pre>
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setState("copied");
              setTimeout(() => setState("idle"), 2500);
            } catch {
              setState("manual");
            }
          }}
        >
          {state === "copied" ? "Copiado" : "Copiar"}
        </Button>
        {state === "manual" ? <span className="text-xs text-zinc-500">Não deu para copiar sozinho: selecione o texto acima.</span> : null}
      </div>
      {hint ? <p className="text-xs text-zinc-500 dark:text-zinc-400">{hint}</p> : null}
    </div>
  );
}

export function RegisterGroupForm({ groups }: { groups: ProviderGroupOption[] }) {
  const [state, formAction] = useActionState(registerGroupAction, INITIAL_STATE);
  const available = groups.filter((group) => group.registeredId === null);
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <Field
        label="Grupo do WhatsApp da loja"
        hint={
          available.length === 0
            ? "Nenhum grupo novo: crie o grupo no celular da loja (com você como admin) e recarregue esta página."
            : "Só grupos de que o número da loja participa. Crie o grupo no celular com você como admin — o Provador nunca adiciona ninguém."
        }
      >
        <Select name="providerGroupId" required defaultValue="">
          <option value="" disabled>
            {available.length === 0 ? "Sem grupos disponíveis" : "Escolha o grupo"}
          </option>
          {available.map((group) => (
            <option key={group.groupId} value={group.groupId}>
              {group.name ?? group.groupId}
            </option>
          ))}
        </Select>
      </Field>
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      <div>
        <SubmitButton disabled={available.length === 0} pendingLabel="Registrando…">
          Registrar como sala do Provador
        </SubmitButton>
      </div>
    </form>
  );
}

export function WelcomeGiftForm({ defaults }: { defaults: { percent: number; days: number } }) {
  const [state, formAction] = useActionState(saveWelcomeGiftAction, INITIAL_STATE);
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4 sm:max-w-sm">
        <Field label="Desconto (%)" hint="Na primeira compra dela.">
          <Input type="number" name="percent" min={1} max={50} defaultValue={defaults.percent} required />
        </Field>
        <Field label="Validade (dias)">
          <Input type="number" name="days" min={1} max={90} defaultValue={defaults.days} required />
        </Field>
      </div>
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      <div>
        <SubmitButton>Salvar</SubmitButton>
      </div>
    </form>
  );
}

export type ProductOption = { id: string; name: string; hint: string | null; disabled: boolean };
export type LookOption = { id: string; label: string };

export type RitualDefaults = Record<"chegadas" | "enquete" | "quem_vestiu" | "turma" | "livre", { day: string; time: string }>;
export type CollectiveCouponOption = { id: string; code: string; currentLabel: string; capLabel: string | null; redeemers: number };

const KIND_LABELS: Record<keyof RitualDefaults, string> = {
  chegadas: "Passou pelo Provador (terça) — o que chegou",
  enquete: "Vocês decidem (quinta) — enquete",
  quem_vestiu: "Quem vestiu (sábado) — foto de cliente",
  turma: "Monte sua turma — cupom que sobe a cada amiga (mensal)",
  livre: "Post livre — texto seu",
};

/**
 * Lista de marcação cujo valor vive no estado do React e vai ao form por
 * inputs ocultos. Depois de uma server action o React 19 RESETA o form
 * (checkbox volta ao defaultChecked, texto solto some): com o estado aqui, a
 * pré-visualização não apaga o que a dona marcou.
 */
function CheckList({
  name,
  options,
  max,
  selected,
  onChange,
  emptyHint,
}: {
  name: string;
  options: { id: string; label: string; hint?: string | null; disabled?: boolean }[];
  max: number;
  selected: string[];
  onChange: (next: string[]) => void;
  emptyHint: string;
}) {
  if (options.length === 0) return <p className="text-sm text-zinc-500 dark:text-zinc-400">{emptyHint}</p>;
  return (
    <>
      {selected.map((id) => (
        <input key={id} type="hidden" name={name} value={id} />
      ))}
      <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded-md border border-zinc-200 p-2 dark:border-zinc-800">
        {options.map((option) => {
          const checked = selected.includes(option.id);
          const full = !checked && selected.length >= max;
          return (
            <li key={option.id}>
              <label className={`flex items-start gap-2 rounded px-2 py-1 text-sm ${option.disabled || full ? "opacity-50" : "hover:bg-zinc-50 dark:hover:bg-zinc-800"}`}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={option.disabled || full}
                  onChange={(event) => onChange(event.target.checked ? [...selected, option.id] : selected.filter((id) => id !== option.id))}
                  className="mt-0.5"
                />
                <span>
                  {option.label}
                  {option.hint ? <span className="block text-xs text-zinc-500 dark:text-zinc-400">{option.hint}</span> : null}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </>
  );
}

type ComposeDraft = {
  productIds: string[];
  vitrineWhen: string;
  question: string;
  options: string;
  outcome: string;
  maxOptions: string;
  voterHoldHours: string;
  pollProductId: string;
  lookIds: string[];
  turmaCouponId: string;
  body: string;
  imageUrl: string;
};

const EMPTY_DRAFT: ComposeDraft = {
  productIds: [],
  vitrineWhen: "",
  question: "",
  options: "",
  outcome: "",
  maxOptions: "1",
  voterHoldHours: "24",
  pollProductId: "",
  lookIds: [],
  turmaCouponId: "",
  body: "",
  imageUrl: "",
};

export function ComposePostForm({
  groupId,
  products,
  looks,
  coupons,
  lookCouponPercent,
  defaults,
  windowLabel,
}: {
  groupId: string;
  products: ProductOption[];
  looks: LookOption[];
  /** Cupons da turma disponíveis (ativos, coletivos). */
  coupons: CollectiveCouponOption[];
  /** O mimo pela foto ligado: a frase "vira X%" entra sozinha no Quem vestiu; null = não entra. */
  lookCouponPercent: number | null;
  defaults: RitualDefaults;
  windowLabel: string;
}) {
  const [kind, setKind] = useState<keyof RitualDefaults>("chegadas");
  const [day, setDay] = useState(defaults.chegadas.day);
  const [time, setTime] = useState(defaults.chegadas.time);
  // Tudo controlado: o reset do form depois da action não apaga o rascunho.
  const [draft, setDraft] = useState<ComposeDraft>(EMPTY_DRAFT);
  const set = <K extends keyof ComposeDraft>(key: K, value: ComposeDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const [state, formAction] = useActionState(async (previous: FormState, formData: FormData) => {
    const result = await composePostAction(previous, formData);
    // Agendou: o rascunho some (o próximo ritual começa do zero).
    if (result.success) setDraft(EMPTY_DRAFT);
    return result;
  }, INITIAL_STATE);

  function changeKind(next: keyof RitualDefaults) {
    setKind(next);
    setDay(defaults[next].day);
    setTime(defaults[next].time);
  }

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <input type="hidden" name="groupId" value={groupId} />
      {/* O ritual vai por input oculto: o reset do form depois da action devolveria o select à primeira opção. */}
      <input type="hidden" name="kind" value={kind} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="Ritual" hint="Cada ritual tem o seu dia; o horário sugerido você pode mudar.">
          <Select value={kind} onChange={(event) => changeKind(event.target.value as keyof RitualDefaults)}>
            {(Object.keys(KIND_LABELS) as (keyof RitualDefaults)[]).map((key) => (
              <option key={key} value={key}>
                {KIND_LABELS[key]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Dia" hint="Vazio = sai agora (se estiver na janela).">
          <Input type="date" name="day" value={day} onChange={(event) => setDay(event.target.value)} />
        </Field>
        <Field label="Hora" hint={`Janela de envio: ${windowLabel}. Domingo fica em silêncio.`}>
          <Input type="time" name="time" value={time} onChange={(event) => setTime(event.target.value)} step={300} />
        </Field>
      </div>

      {kind === "chegadas" ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Peças (até 3)" hint="Só peças ativas, com preço e estoque. O estoque por tamanho entra sozinho no texto, do jeito que está no ledger.">
            <CheckList
              name="productIds"
              options={products.map((p) => ({ id: p.id, label: p.name, hint: p.hint, disabled: p.disabled }))}
              max={3}
              selected={draft.productIds}
              onChange={(next) => set("productIds", next)}
              emptyHint="Nenhuma peça ativa com preço e estoque."
            />
          </Field>
          <Field label="Quando vai para a vitrine" hint='Ex.: "amanhã às 9h". Vazio = já está na vitrine.'>
            <Input name="vitrineWhen" maxLength={60} placeholder="amanhã às 9h" autoComplete="off" value={draft.vitrineWhen} onChange={(e) => set("vitrineWhen", e.target.value)} />
          </Field>
        </div>
      ) : null}

      {kind === "enquete" ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Pergunta" hint='Ex.: "A Blusa Marfim volta em uma cor a mais — qual?"'>
            <Input name="question" maxLength={255} required autoComplete="off" value={draft.question} onChange={(e) => set("question", e.target.value)} />
          </Field>
          <Field label="Opções (uma por linha, 2 a 12)">
            <TextArea name="options" rows={4} required placeholder={"Verde-oliva\nVinho\nAzul-noite"} value={draft.options} onChange={(e) => set("options", e.target.value)} />
          </Field>
          <Field label="O que acontece com a vencedora" hint='Ex.: "chega em 15 dias". Vazio = sem promessa.'>
            <Input name="outcome" maxLength={80} placeholder="chega em 15 dias" autoComplete="off" value={draft.outcome} onChange={(e) => set("outcome", e.target.value)} />
          </Field>
          <Field label="Peça da enquete (opcional)" hint="Quando a cor (ou o tamanho) vencedora chegar ao estoque desta peça, quem votou nela é avisada no privado antes de todo mundo. Para o aviso sair, escreva as opções exatamente como a cor está no cadastro da peça (ex.: “Verde-oliva”, não “Verde”).">
            <Select name="pollProductId" value={draft.pollProductId} onChange={(e) => set("pollProductId", e.target.value)}>
              <option value="">Sem peça</option>
              {products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Marcações por pessoa">
              <Input type="number" name="maxOptions" min={1} max={12} value={draft.maxOptions} onChange={(e) => set("maxOptions", e.target.value)} />
            </Field>
            <Field label="Reserva de quem votou (h)" hint="0 = sem recompensa.">
              <Input type="number" name="voterHoldHours" min={0} max={168} value={draft.voterHoldHours} onChange={(e) => set("voterHoldHours", e.target.value)} />
            </Field>
          </div>
        </div>
      ) : null}

      {kind === "quem_vestiu" ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Looks (até 2)" hint="Só fotos com o sim da cliente e aprovadas em Produtos › Quem já vestiu.">
            <CheckList
              name="lookIds"
              options={looks.map((look) => ({ id: look.id, label: look.label }))}
              max={2}
              selected={draft.lookIds}
              onChange={(next) => set("lookIds", next)}
              emptyHint="Nenhum look aprovado ainda."
            />
          </Field>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {lookCouponPercent
              ? `O mimo pela foto está ligado: o post diz que foto vestindo a peça vira ${lookCouponPercent}% na próxima compra.`
              : "O mimo pela foto está desligado (Cupons › Mimo pela foto): o post não promete cupom."}
          </p>
        </div>
      ) : null}

      {kind === "turma" ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Cupom da turma" hint="Um cupom coletivo criado em Cupons (sobe a cada amiga que usa). O post mostra o valor de hoje, quanto sobe e o teto, com o link que aplica sozinho — por isso só se agenda para as próximas 24 h.">
            <Select name="turmaCouponId" value={draft.turmaCouponId} onChange={(e) => set("turmaCouponId", e.target.value)}>
              <option value="">{coupons.length === 0 ? "Nenhum cupom da turma ativo" : "Escolha o cupom"}</option>
              {coupons.map((coupon) => (
                <option key={coupon.id} value={coupon.id}>
                  {coupon.code} — hoje {coupon.currentLabel}
                  {coupon.capLabel ? `, até ${coupon.capLabel}` : ""} · {coupon.redeemers} {coupon.redeemers === 1 ? "usou" : "usaram"}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      ) : null}

      {kind === "livre" ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Texto" hint="Curto, concreto, sem “compre agora”. Termine com um convite para falar com a Lia no privado.">
            <TextArea name="body" rows={6} maxLength={1500} required value={draft.body} onChange={(e) => set("body", e.target.value)} />
          </Field>
          <Field label="Imagem (URL pública, opcional)" hint="Com imagem, o texto vai como legenda.">
            <Input name="imageUrl" type="url" placeholder="https://…" autoComplete="off" value={draft.imageUrl} onChange={(e) => set("imageUrl", e.target.value)} />
          </Field>
        </div>
      ) : null}

      {state.preview ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900 dark:bg-emerald-950">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-emerald-700 dark:text-emerald-300">Como vai sair no grupo</p>
          <pre className="whitespace-pre-wrap font-sans text-sm text-zinc-800 dark:text-zinc-200">{state.preview}</pre>
        </div>
      ) : null}
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" name="intent" value="preview" variant="outline">
          Pré-visualizar
        </Button>
        <SubmitButton name="intent" value="schedule" pendingLabel="Agendando…">
          Agendar no Provador
        </SubmitButton>
      </div>
    </form>
  );
}
