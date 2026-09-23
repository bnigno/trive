"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ZodError } from "zod";

import { getDb } from "@/db/client";
import { formatCentsBRL, parseBRLToCents } from "@/lib/money";
import { OrderTotalsError } from "@/core/orders/totals";
import { requireUser } from "@/services/auth";
import { createManualOrder, ServiceError } from "@/services/orders";
import { quoteCoupon, ServiceError as CouponServiceError } from "@/services/coupons";
import { couponErrorMessage } from "@/core/coupons/messages";

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
    const couponCode = String(formData.get("couponCode") ?? "").trim();
    const forceCoupon = formData.get("forceCoupon") === "on";
    const shippingKind = String(formData.get("shippingKind") ?? "") === "correios" ? "correios" : "motoboy";

    const db = getDb();
    const result = await createManualOrder(db, {
      customerId,
      items,
      discountCents: rawDiscount ? parseMoneyOr(rawDiscount, "desconto") : 0,
      shippingCents: rawShipping ? parseMoneyOr(rawShipping, "frete") : 0,
      ...(couponCode ? { couponCode, forceCoupon, shippingKind } : {}),
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

// ---------------------------------------------------------------------------
// Conferir o cupom antes de salvar (mesmo motor do site). Não grava nada.
// ---------------------------------------------------------------------------

export type QuoteCouponState =
  | { kind: "idle" }
  | { kind: "ok"; code: string; label: string; discountCents: number; shippingDiscountCents: number }
  | { kind: "refused"; code: string; message: string }
  | {
      kind: "forced";
      code: string;
      label: string;
      reasons: string;
      discountCents: number;
      shippingDiscountCents: number;
    };

const NEUTRAL_RULE = {
  minOrderCents: 0,
  freeShippingScope: "any" as const,
  validWeekdays: null,
  validFromMinute: null,
  validToMinute: null,
};

export async function quoteManualCouponAction(
  _prev: QuoteCouponState,
  formData: FormData,
): Promise<QuoteCouponState> {
  await requireUser();
  const code = String(formData.get("couponCode") ?? "").trim();
  if (!code) return { kind: "idle" };
  const force = formData.get("forceCoupon") === "on";
  const customerId = String(formData.get("customerId") ?? "").trim();
  const variantIds = formData.getAll("itemVariantId").map((value) => String(value));
  const quantities = formData.getAll("itemQuantity").map((value) => String(value));
  const prices = formData.getAll("itemUnitPrice").map((value) => String(value));

  const money = (raw: string): number | undefined => {
    if (!raw.trim()) return undefined;
    try {
      return parseBRLToCents(raw);
    } catch {
      return undefined;
    }
  };

  const items = variantIds.flatMap((variantId, index) => {
    if (!variantId) return [];
    const quantity = Number(quantities[index] ?? "1");
    if (!Number.isInteger(quantity) || quantity <= 0) return [];
    const override = money(prices[index] ?? "");
    return [{ variantId, quantity, ...(override !== undefined ? { unitPriceCentsOverride: override } : {}) }];
  });
  if (items.length === 0) {
    return { kind: "refused", code, message: "Escolha as peças do pedido antes de conferir o cupom." };
  }

  const shippingCents = money(String(formData.get("shipping") ?? "")) ?? 0;
  const shippingKind = String(formData.get("shippingKind") ?? "") === "correios" ? "correios" : "motoboy";

  try {
    const quote = await quoteCoupon(getDb(), {
      code,
      items,
      ...(customerId ? { identity: { customerId } } : {}),
      shipping: shippingCents > 0 ? { cents: shippingCents, kind: shippingKind } : null,
      force,
    });
    const label = quote.freeShipping
      ? `frete grátis (− ${formatCentsBRL(quote.shippingDiscountCents)})`
      : `− ${formatCentsBRL(quote.discountCents)}`;
    if (quote.forced.length > 0) {
      const reasons = quote.forced
        .map((reason) => couponErrorMessage(reason, { code: quote.code, ...NEUTRAL_RULE }))
        .join(" ");
      return {
        kind: "forced",
        code: quote.code,
        label,
        reasons,
        discountCents: quote.discountCents,
        shippingDiscountCents: quote.shippingDiscountCents,
      };
    }
    return {
      kind: "ok",
      code: quote.code,
      label,
      discountCents: quote.discountCents,
      shippingDiscountCents: quote.shippingDiscountCents,
    };
  } catch (error) {
    if (error instanceof CouponServiceError) {
      return { kind: "refused", code, message: error.message };
    }
    return { kind: "refused", code, message: "Não foi possível conferir o cupom agora. Tente de novo." };
  }
}
