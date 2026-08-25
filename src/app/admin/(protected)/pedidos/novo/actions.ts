"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ZodError } from "zod";

import { getDb } from "@/db/client";
import { parseBRLToCents } from "@/lib/money";
import { OrderTotalsError } from "@/core/orders/totals";
import { requireUser } from "@/services/auth";
import { createManualOrder, ServiceError } from "@/services/orders";

export type FormState = { error?: string; success?: string };

function parseMoneyOr(value: string, fieldLabel: string): number {
  try {
    const cents = parseBRLToCents(value);
    if (cents < 0) {
      throw new RangeError("negativo");
    }
    return cents;
  } catch {
    throw new ServiceError(
      "VALOR_INVALIDO",
      `Valor inválido em "${fieldLabel}". Use o formato 1.234,56 (sem valores negativos).`,
    );
  }
}

export async function createOrderAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();

  let orderId: string;
  try {
    const customerId = String(formData.get("customerId") ?? "").trim();
    if (!customerId) {
      return { error: "Selecione o cliente do pedido." };
    }

    const variantIds = formData.getAll("itemVariantId").map(String);
    const quantities = formData.getAll("itemQuantity").map(String);
    const unitPrices = formData.getAll("itemUnitPrice").map(String);

    const items: {
      variantId: string;
      quantity: number;
      unitPriceCentsOverride?: number;
    }[] = [];
    for (let i = 0; i < variantIds.length; i += 1) {
      const variantId = variantIds[i].trim();
      if (!variantId) continue; // linha em branco — ignora

      const quantity = Number(quantities[i] ?? "");
      if (!Number.isInteger(quantity) || quantity <= 0) {
        return {
          error: `Quantidade inválida no item ${i + 1}. Use um número inteiro maior que zero.`,
        };
      }

      const rawPrice = (unitPrices[i] ?? "").trim();
      items.push({
        variantId,
        quantity,
        ...(rawPrice
          ? {
              unitPriceCentsOverride: parseMoneyOr(
                rawPrice,
                `preço do item ${i + 1}`,
              ),
            }
          : {}),
      });
    }
    if (items.length === 0) {
      return { error: "Adicione ao menos um item ao pedido." };
    }

    const rawDiscount = String(formData.get("discount") ?? "").trim();
    const rawShipping = String(formData.get("shipping") ?? "").trim();
    const note = String(formData.get("note") ?? "").trim();

    const db = getDb();
    const result = await createManualOrder(db, {
      customerId,
      items,
      discountCents: rawDiscount ? parseMoneyOr(rawDiscount, "desconto") : 0,
      shippingCents: rawShipping ? parseMoneyOr(rawShipping, "frete") : 0,
      note: note || undefined,
      userId: user.id,
    });
    orderId = result.orderId;
  } catch (error) {
    if (error instanceof ServiceError || error instanceof OrderTotalsError) {
      return { error: error.message };
    }
    if (error instanceof ZodError) {
      return {
        error: "Confira os dados do pedido: há campos inválidos ou faltando.",
      };
    }
    return { error: "Algo deu errado, tente novamente." };
  }

  revalidatePath("/admin/pedidos");
  redirect(`/admin/pedidos/${orderId}`);
}
