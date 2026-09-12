"use client";

import { useActionState, useState } from "react";

import { Field, FormError, FormSuccess, Input, Select, SubmitButton } from "@/components/ui/form";
import { normalizeCampaignSlug } from "@/core/bot/site-bridge";

import { createCampaignLinkAction, updateCampaignLinkAction, type FormState } from "./actions";

const INITIAL_STATE: FormState = {};

export type ProductOption = { id: string; name: string };

function ProductSelect({ name, options, defaultValue }: { name: string; options: ProductOption[]; defaultValue?: string }) {
  return (
    <Select name={name} defaultValue={defaultValue ?? ""}>
      <option value="">Sem peça (link geral)</option>
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.name}
        </option>
      ))}
    </Select>
  );
}

export function CampaignLinkCreateForm({ siteUrl, products }: { siteUrl: string; products: ProductOption[] }) {
  const [state, formAction] = useActionState(createCampaignLinkAction, INITIAL_STATE);
  const [slug, setSlug] = useState("");
  const preview = normalizeCampaignSlug(slug);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          label="Nome do link"
          hint={
            preview
              ? `Vai ficar ${siteUrl}/ig/${preview}`
              : "Curto e fácil de lembrar. Ex.: dunas, cirio-2026. Depois de criado não muda."
          }
        >
          <Input
            name="slug"
            required
            maxLength={80}
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            placeholder="dunas"
            autoComplete="off"
            autoCapitalize="none"
          />
        </Field>
        <Field label="Rótulo" hint="Como a origem aparece para você e para a Lia. Ex.: Dunas no story do Círio.">
          <Input name="label" required maxLength={60} placeholder="Dunas no story" autoComplete="off" />
        </Field>
        <Field label="Peça do story" hint="A cliente chega à Lia já falando dessa peça; o preview do link mostra o cartão dela.">
          <ProductSelect name="productId" options={products} />
        </Field>
      </div>
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      <div>
        <SubmitButton>Criar link</SubmitButton>
      </div>
    </form>
  );
}

export function CampaignLinkEditForm({
  linkId,
  defaults,
  products,
}: {
  linkId: string;
  defaults: { label: string; productId: string };
  products: ProductOption[];
}) {
  const [state, formAction] = useActionState(updateCampaignLinkAction, INITIAL_STATE);
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="id" value={linkId} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Rótulo">
          <Input name="label" required maxLength={60} defaultValue={defaults.label} autoComplete="off" />
        </Field>
        <Field label="Peça do story">
          <ProductSelect name="productId" options={products} defaultValue={defaults.productId} />
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
