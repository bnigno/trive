"use server";

// Fechamento do pedido da loja. O servidor SEMPRE recalcula preços, frete e
// total via createStoreOrder — o cliente só informa o que VIU (expected*)
// para o serviço detectar divergência (CDC: preço anunciado vincula).

import { ZodError } from "zod";

import { getDb } from "@/db/client";
import {
  createStoreOrder,
  PriceChangedError,
  ServiceError,
  ShippingChangedError,
  type CreateStoreOrderInput,
  type PriceChange,
} from "@/services/store-orders";

export type PlaceOrderResult =
  | { ok: true; publicToken: string; orderNumber: number }
  | { ok: false; kind: "price_changed"; changes: PriceChange[] }
  | { ok: false; kind: "shipping_changed"; newShippingCents: number }
  | { ok: false; kind: "error"; code: string; message: string };

export async function placeOrderAction(
  input: CreateStoreOrderInput,
): Promise<PlaceOrderResult> {
  try {
    const db = getDb();
    // createStoreOrder valida TUDO com Zod internamente (documento, telefone,
    // endereço, itens) — nenhuma confiança no payload do cliente.
    const result = await createStoreOrder(db, input);
    return {
      ok: true,
      publicToken: result.publicToken,
      orderNumber: result.orderNumber,
    };
  } catch (error) {
    if (error instanceof PriceChangedError) {
      return { ok: false, kind: "price_changed", changes: error.changes };
    }
    if (error instanceof ShippingChangedError) {
      return {
        ok: false,
        kind: "shipping_changed",
        newShippingCents: error.newPriceCents,
      };
    }
    if (error instanceof ServiceError) {
      return { ok: false, kind: "error", code: error.code, message: error.message };
    }
    if (error instanceof ZodError) {
      const first = error.issues[0]?.message;
      return {
        ok: false,
        kind: "error",
        code: "VALIDATION",
        message: first
          ? `Confira os dados informados: ${first}`
          : "Confira os dados informados: há campos inválidos ou faltando.",
      };
    }
    return {
      ok: false,
      kind: "error",
      code: "UNKNOWN",
      message: "Algo deu errado ao enviar o pedido. Tente novamente em instantes.",
    };
  }
}
