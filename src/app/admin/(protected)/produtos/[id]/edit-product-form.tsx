"use client";

import { useActionState } from "react";
import {
  Field,
  FormError,
  FormSuccess,
  Input,
  Select,
  SubmitButton,
  TextArea,
} from "@/components/ui/form";
import { updateProductAction, type FormState } from "./actions";

export type CategoryOption = { id: string; name: string };
export type SupplierOption = { id: string; name: string };

const initialState: FormState = {};

export function EditProductForm({
  product,
  categoryOptions,
  supplierOptions,
}: {
  product: {
    id: string;
    name: string;
    description: string | null;
    brand: string | null;
    categoryId: string | null;
    supplierId: string | null;
    attributesSchema: string[];
  };
  categoryOptions: CategoryOption[];
  supplierOptions: SupplierOption[];
}) {
  const [state, formAction] = useActionState(updateProductAction, initialState);

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
        <Field label="Descrição" className="sm:col-span-2">
          <TextArea
            name="description"
            defaultValue={product.description ?? ""}
            placeholder="Descreva o produto (opcional)"
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
      <FormError message={state.error} />
      <FormSuccess message={state.success} />
      <div>
        <SubmitButton pendingLabel="Salvando…">Salvar alterações</SubmitButton>
      </div>
    </form>
  );
}
