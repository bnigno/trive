"use client";

import { useActionState, useState } from "react";
import { PIECE_TYPES, suggestPieceType } from "@/core/catalog/piece-types";
import { DESCRIPTION_MIN_CHARS } from "@/core/catalog/readiness";
import {
  Field,
  FormError,
  FormSuccess,
  Input,
  Select,
  SubmitButton,
  TextArea,
} from "@/components/ui/form";
import { parseCareNotes } from "@/core/catalog/care";
import { CareFields } from "../care-fields";
import { updateProductAction, type FormState } from "./actions";

export type CategoryOption = { id: string; name: string };
export type SupplierOption = { id: string; name: string };

const initialState: FormState = {};

export function EditProductForm({
  product,
  categoryOptions,
  supplierOptions,
  autoFocusDescription = false,
  autoFocusField,
}: {
  product: {
    id: string;
    name: string;
    description: string | null;
    brand: string | null;
    categoryId: string | null;
    pieceType: string | null;
    supplierId: string | null;
    attributesSchema: string[];
    composition: string | null;
    careNotes: string | null;
    fitNotes: string | null;
  };
  categoryOptions: CategoryOption[];
  supplierOptions: SupplierOption[];
  /** Vindo do selo "descrição curta": o cursor já cai no campo. */
  autoFocusDescription?: boolean;
  /** Vindo do card "o que falta para a Lia": o cursor cai no campo da ficha. */
  autoFocusField?: "composition" | "fitNotes" | "pieceType";
}) {
  const [state, formAction] = useActionState(updateProductAction, initialState);
  const [descriptionLength, setDescriptionLength] = useState(
    (product.description ?? "").trim().length,
  );
  const care = parseCareNotes(product.careNotes);
  const descriptionHint =
    descriptionLength >= DESCRIPTION_MIN_CHARS
      ? `${descriptionLength} caracteres — boa para a vitrine e para a Lia.`
      : `${descriptionLength} de ${DESCRIPTION_MIN_CHARS} caracteres. Conte tecido, caimento, ocasião e como veste no calor.`;

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="productId" value={product.id} />
      <input type="hidden" name="currentName" value={product.name} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Nome"
          className="sm:col-span-2"
          hint="Mudar o nome não altera os códigos (SKU) das variações; para ajustá-los, use “Editar variações” logo abaixo."
        >
          <Input name="name" defaultValue={product.name} required />
        </Field>
        <Field label="Descrição" className="sm:col-span-2" hint={descriptionHint}>
          <TextArea
            name="description"
            defaultValue={product.description ?? ""}
            placeholder="Descreva a peça: tecido, caimento, ocasião, como veste no calor de Belém."
            rows={5}
            autoFocus={autoFocusDescription}
            onChange={(event) => setDescriptionLength(event.target.value.trim().length)}
          />
        </Field>
        <Field label="Marca">
          <Input
            name="brand"
            defaultValue={product.brand ?? ""}
            placeholder="Opcional"
          />
        </Field>
        <Field label="Categoria">
          <Select name="categoryId" defaultValue={product.categoryId ?? ""}>
            <option value="">Sem categoria</option>
            {categoryOptions.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Tipo de peça"
          className="sm:col-span-2"
          hint={`A Lia usa o tipo para achar a peça quando a cliente pede "um corset" ou "vestidos". ${product.pieceType ? "" : "Sugerido pelo nome quando vazio — confira antes de salvar. "}Falta um tipo? Peça para incluir na lista — é uma linha no código, sem mexer nas peças.`}
        >
          <Select name="pieceType" defaultValue={product.pieceType ?? suggestPieceType(product.name) ?? ""} autoFocus={autoFocusField === "pieceType"}>
            <option value="">Sem tipo</option>
            {PIECE_TYPES.map((type) => (
              <option key={type.slug} value={type.slug}>
                {type.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Fornecedor"
          className="sm:col-span-2"
          hint="De quem você compra este produto. Compras registradas no estoque com esse fornecedor aparecem na página dele."
        >
          <Select name="supplierId" defaultValue={product.supplierId ?? ""}>
            <option value="">Sem fornecedor</option>
            {supplierOptions.map((supplier) => (
              <option key={supplier.id} value={supplier.id}>
                {supplier.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Eixos de variação"
          className="sm:col-span-2"
          hint='Separe por vírgula, ex.: "cor, tamanho". As variações existentes não são alteradas.'
        >
          <Input
            name="axes"
            defaultValue={product.attributesSchema.join(", ")}
            placeholder="cor, tamanho"
          />
        </Field>
      </div>

      <div className="flex flex-col gap-1 border-t border-zinc-200 pt-4 dark:border-zinc-800">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Ficha da peça</h3>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Vira a placa de museu na página da peça, entra no cartão da caixa e a Lia responde por ela.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Composição" className="sm:col-span-2" hint="Ex.: 100% linho · forro 100% viscose">
          <Input name="composition" defaultValue={product.composition ?? ""} placeholder="Tecido e forro" autoFocus={autoFocusField === "composition"} />
        </Field>
        <CareFields symbols={care.symbols} freeText={care.freeText} />
        <Field
          label="Como veste"
          className="sm:col-span-2"
          hint="Caimento, modelagem, altura da modelo, se marca ou solta."
        >
          <TextArea
            name="fitNotes"
            autoFocus={autoFocusField === "fitNotes"}
            rows={3}
            defaultValue={product.fitNotes ?? ""}
            placeholder="Ex.: Caimento fluido, comprimento midi; a modelo tem 1,68 m e veste M."
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
