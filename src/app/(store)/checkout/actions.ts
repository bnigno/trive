"use server";

// Fechamento do pedido da loja. O servidor SEMPRE recalcula preços, frete e
// total via createStoreOrder — o cliente só informa o que VIU (expected*)
// para o serviço detectar divergência (CDC: preço anunciado vincula).

import { z, ZodError } from "zod";

import { getCepLookup } from "@/adapters/cep";
import { lookupAddressByCep, type AddressLookupResult } from "@/services/address-lookup";

import { getPaymentGateway } from "@/adapters/mercadopago";
import { getDb } from "@/db/client";
import {
  ensurePaymentPreference,
  isMpEnabled,
} from "@/services/store-payments";
import {
  createStoreOrder,
  PriceChangedError,
  ServiceError,
  ShippingChangedError,
  type CreateStoreOrderInput,
  type PriceChange,
} from "@/services/store-orders";

export type PlaceOrderResult =
  | {
      ok: true;
      publicToken: string;
      orderNumber: number;
      /**
       * Quando o Mercado Pago está habilitado: URL do Checkout Pro para o
       * client redirecionar DIRETO (pagamento imediato). Null → fluxo manual
       * (página do pedido + WhatsApp), que continua funcionando sempre.
       */
      initPointUrl: string | null;
    }
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
    // O navegador só faz pedido da LOJA: o canal "whatsapp" é da Lia (servidor).
    // Sem isto, um payload forjado se passaria por venda da vendedora e sairia
    // da conciliação e do lembrete de pagamento do site.
    const result = await createStoreOrder(db, { ...input, channel: "store" });

    // Pagamento automático: se o MP está habilitado, já cria a preference e
    // devolve o link do Checkout Pro. QUALQUER falha aqui NÃO derruba o
    // pedido (ele já existe e está reservado) — apenas cai no fluxo manual.
    // Dinheiro na entrega NUNCA cria preference: o cliente vai direto para a
    // página do pedido e o dono baixa o pagamento manualmente.
    let initPointUrl: string | null = null;
    try {
      if (input.paymentMethod !== "cash" && (await isMpEnabled(db))) {
        const preference = await ensurePaymentPreference(
          db,
          getPaymentGateway(),
          { orderId: result.orderId },
        );
        initPointUrl = preference.initPointUrl;
      }
    } catch (mpError) {
      console.error(
        "placeOrderAction: falha ao criar preference do Mercado Pago — seguindo no fluxo manual.",
        mpError,
      );
    }

    return {
      ok: true,
      publicToken: result.publicToken,
      orderNumber: result.orderNumber,
      initPointUrl,
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

const lookupCepSchema = z.object({ cep: z.string().trim().min(1).max(12) });

/** Endereço pelo CEP para o preenchimento automático do checkout (sem banco). */
export async function lookupCepAction(input: { cep: string }): Promise<AddressLookupResult> {
  const parsed = lookupCepSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "cep_invalido" };
  return lookupAddressByCep(getCepLookup(), parsed.data.cep);
}
