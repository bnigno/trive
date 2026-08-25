"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "@/db/client";
import { auditLog, customerAddresses } from "@/db/schema";
import { requireUser } from "@/services/auth";
import { ServiceError } from "@/services/catalog";
import {
  addAddress,
  createCustomer,
  updateCustomer,
} from "@/services/customers";

export type FormState = { error?: string; success?: string };

/** Extrai a mensagem pt-BR de erros conhecidos; genérica para o resto. */
function toErrorState(error: unknown): FormState {
  if (error instanceof ServiceError) return { error: error.message };
  if (error instanceof z.ZodError) {
    const first = error.issues[0]?.message;
    if (first) return { error: first };
  }
  console.error("[clientes] erro inesperado:", error);
  return { error: "Algo deu errado, tente novamente." };
}

/** Campo de texto do form: string aparada ou undefined se vazio. */
function text(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function addressFromForm(formData: FormData) {
  const fields = {
    label: text(formData, "addressLabel"),
    postalCode: text(formData, "postalCode"),
    street: text(formData, "street"),
    number: text(formData, "number"),
    complement: text(formData, "complement"),
    district: text(formData, "district"),
    city: text(formData, "city"),
    state: text(formData, "state")?.toUpperCase(),
  };
  const hasAny = Object.values(fields).some((value) => value !== undefined);
  return { fields, hasAny };
}

// ---------------------------------------------------------------------------
// Criar cliente
// ---------------------------------------------------------------------------

export async function createCustomerAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();

  const fullName = text(formData, "fullName");
  if (!fullName) return { error: "Informe o nome do cliente." };

  const { fields: address, hasAny: hasAddress } = addressFromForm(formData);
  if (hasAddress && address.state && address.state.length !== 2) {
    return { error: "UF deve ter 2 letras, ex.: SP." };
  }

  let customerId: string;
  try {
    const db = getDb();
    const customer = await createCustomer(db, {
      fullName,
      email: text(formData, "email"),
      phone: text(formData, "phone"),
      document: text(formData, "document"),
      notes: text(formData, "notes"),
      marketingOptIn: formData.get("marketingOptIn") === "on",
      address: hasAddress ? address : undefined,
      userId: user.id,
    });
    customerId = customer.id;
  } catch (error) {
    return toErrorState(error);
  }

  revalidatePath("/admin/clientes");
  redirect(`/admin/clientes/${customerId}`);
}

// ---------------------------------------------------------------------------
// Atualizar cliente
// ---------------------------------------------------------------------------

export async function updateCustomerAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();

  const customerId = z.uuid().safeParse(formData.get("customerId"));
  if (!customerId.success) {
    return { error: "Algo deu errado, tente novamente." };
  }

  const fullName = text(formData, "fullName");
  if (!fullName) return { error: "Informe o nome do cliente." };

  try {
    const db = getDb();
    await updateCustomer(db, {
      customerId: customerId.data,
      userId: user.id,
      fullName,
      // Campo vazio limpa o dado no cadastro.
      email: text(formData, "email") ?? null,
      phone: text(formData, "phone") ?? null,
      document: text(formData, "document") ?? null,
      notes: text(formData, "notes") ?? null,
      marketingOptIn: formData.get("marketingOptIn") === "on",
    });
  } catch (error) {
    return toErrorState(error);
  }

  revalidatePath(`/admin/clientes/${customerId.data}`);
  revalidatePath("/admin/clientes");
  return { success: "Dados do cliente salvos." };
}

// ---------------------------------------------------------------------------
// Endereços
// ---------------------------------------------------------------------------

export async function addAddressAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();

  const customerId = z.uuid().safeParse(formData.get("customerId"));
  if (!customerId.success) {
    return { error: "Algo deu errado, tente novamente." };
  }

  const { fields, hasAny } = addressFromForm(formData);
  if (!hasAny) {
    return { error: "Preencha ao menos um campo do endereço." };
  }
  if (fields.state && fields.state.length !== 2) {
    return { error: "UF deve ter 2 letras, ex.: SP." };
  }

  try {
    const db = getDb();
    await addAddress(db, {
      ...fields,
      customerId: customerId.data,
      userId: user.id,
      isDefault: formData.get("isDefault") === "on" ? true : undefined,
    });
  } catch (error) {
    return toErrorState(error);
  }

  revalidatePath(`/admin/clientes/${customerId.data}`);
  return { success: "Endereço adicionado." };
}

/**
 * Marca um endereço existente como padrão. Não há função de serviço para
 * isso na Fase 1, então a action faz a transação diretamente (com auditoria),
 * seguindo o precedente de src/app/admin/(protected)/fila/actions.ts.
 */
export async function setDefaultAddressAction(
  formData: FormData,
): Promise<void> {
  const user = await requireUser();

  const addressId = z.uuid().safeParse(formData.get("addressId"));
  if (!addressId.success) return;

  const db = getDb();
  let customerId: string | null = null;

  await db.transaction(async (tx) => {
    const [address] = await tx
      .select()
      .from(customerAddresses)
      .where(eq(customerAddresses.id, addressId.data))
      .limit(1);
    if (!address || address.isDefault) return;
    customerId = address.customerId;

    await tx
      .update(customerAddresses)
      .set({ isDefault: false })
      .where(
        and(
          eq(customerAddresses.customerId, address.customerId),
          eq(customerAddresses.isDefault, true),
        ),
      );
    await tx
      .update(customerAddresses)
      .set({ isDefault: true })
      .where(eq(customerAddresses.id, address.id));

    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: user.id,
      action: "customer_address.set_default",
      entityType: "customer_address",
      entityId: address.id,
      before: { isDefault: false },
      after: { isDefault: true },
    });
  });

  if (customerId) revalidatePath(`/admin/clientes/${customerId}`);
}
