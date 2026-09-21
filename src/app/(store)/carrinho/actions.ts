"use server";

// Cotação de frete do carrinho: o CLIENTE só manda variantId + quantidade;
// os pesos vêm do banco (nunca do cliente) e o preço de cada opção vem da
// tabela shipping_rates via quoteShipping.

import { inArray } from "drizzle-orm";
import { z, ZodError } from "zod";

import { getCorreiosQuoter } from "@/adapters/superfrete";
import { getDb } from "@/db/client";
import { productVariants } from "@/db/schema";
import { pendingNotice } from "@/core/coupons/messages";
import { normalizeDocument } from "@/lib/document";
import { toE164BR } from "@/lib/phone";
import {
  quoteCoupon,
  ServiceError as CouponServiceError,
} from "@/services/coupons";
import { motoboyAreaLabel, motoboyCoversCep, type DeliveryOption } from "@/core/shipping/delivery-windows";
import { computeTotalWeightGrams, quoteDeliveryOptions, ServiceError } from "@/services/store-catalog";
import { listShippingRates } from "@/services/shipping";
import { loadBridgeSettings, plainBridgeUrl } from "@/services/site-carts";

const quoteShippingActionSchema = z.object({
  cep: z.string().trim().min(1, "Informe o CEP."),
  items: z
    .array(
      z.object({
        variantId: z.uuid(),
        quantity: z.number().int().positive().max(999),
      }),
    )
    .min(1, "A sacola está vazia.")
    .max(100),
});

export type QuoteShippingActionInput = z.input<typeof quoteShippingActionSchema>;

export type QuoteShippingActionResult =
  | {
      ok: true;
      /** Opções escolhíveis: Correios (1 por faixa) e motoboy (1 por janela, hoje/amanhã pelo relógio de SP). */
      options: DeliveryOption[];
      /** Link wa.me quando store_whatsapp está configurado; null caso contrário. */
      whatsappUrl: string | null;
      /** Nome da vendedora (bot_seller_name), para o aviso "fale com a Lia". */
      sellerName: string;
      /** Onde o motoboy chega ("Belém, Ananindeua e Castanhal"); vazio sem faixa de motoboy. */
      motoboyArea: string;
    }
  | { ok: false; error: string };

export async function quoteShippingAction(
  input: QuoteShippingActionInput,
): Promise<QuoteShippingActionResult> {
  try {
    const parsed = quoteShippingActionSchema.parse(input);
    const db = getDb();

    // Pesos das variantes direto do banco; variante desconhecida entra com
    // peso null e recebe o peso padrão de computeTotalWeightGrams.
    const variantIds = parsed.items.map((item) => item.variantId);
    const rows = await db
      .select({ id: productVariants.id, weightGrams: productVariants.weightGrams })
      .from(productVariants)
      .where(inArray(productVariants.id, variantIds));
    const weightByVariant = new Map(rows.map((row) => [row.id, row.weightGrams]));

    const totalWeightGrams = computeTotalWeightGrams(
      parsed.items.map((item) => ({
        weightGrams: weightByVariant.get(item.variantId) ?? null,
        quantity: item.quantity,
      })),
    );

    // Sem faixa para o CEP, PAC/SEDEX cotados na hora (quando a dona ligou o Correios automático).
    const options = await quoteDeliveryOptions(db, { cep: parsed.cep, totalWeightGrams }, { correios: getCorreiosQuoter() });

    // Só precisamos do WhatsApp e da área do motoboy quando não há opção de
    // entrega, mas ler é barato e evita uma segunda action.
    const bridge = await loadBridgeSettings(db);
    const whatsappUrl = plainBridgeUrl(bridge);
    let motoboyArea = "";
    if (options.length === 0) {
      const rates = await listShippingRates(db);
      // Um motoboy cobre o CEP mas não o peso da sacola: não é "fora da área".
      motoboyArea = motoboyCoversCep(rates, parsed.cep) ? "" : motoboyAreaLabel(rates);
    }

    return { ok: true, options, whatsappUrl, sellerName: bridge.sellerName, motoboyArea };
  } catch (error) {
    if (error instanceof ServiceError) {
      return { ok: false, error: error.message };
    }
    if (error instanceof ZodError) {
      return {
        ok: false,
        error: "Não foi possível cotar o frete: confira o CEP e os itens da sacola.",
      };
    }
    return { ok: false, error: "Algo deu errado ao cotar o frete. Tente novamente." };
  }
}

// ---------------------------------------------------------------------------
// Cupom de desconto: o cliente manda o código + variantId/quantidade (e, se
// já escolheu, a entrega; no checkout, CPF e telefone). Preços vêm do banco
// (nunca do cliente) e a regra mora em core/coupons via quoteCoupon. Sem
// identidade, as regras por cliente ficam pendentes — o aviso diz isso.
// ---------------------------------------------------------------------------

const quoteCouponActionSchema = z.object({
  code: z.string().trim().min(1, "Informe o código do cupom."),
  items: z
    .array(
      z.object({
        variantId: z.uuid(),
        quantity: z.number().int().positive().max(999),
      }),
    )
    .min(1, "A sacola está vazia.")
    .max(100),
  /** Entrega já escolhida na sacola/checkout (valor e tipo), se houver. */
  shipping: z
    .object({ cents: z.number().int().min(0), kind: z.enum(["motoboy", "correios"]) })
    .nullable()
    .optional(),
  /** Só o checkout manda: CPF/CNPJ e telefone válidos confirmam as regras por cliente. */
  customer: z
    .object({ document: z.string().trim().min(1), phone: z.string().trim().min(1) })
    .nullable()
    .optional(),
});

export type QuoteCouponActionInput = z.input<typeof quoteCouponActionSchema>;

export type QuoteCouponActionResult =
  | {
      ok: true;
      /** Código normalizado (UPPERCASE), como será gravado no pedido. */
      code: string;
      discountCents: number;
      freeShipping: boolean;
      /** Frete perdoado com a entrega informada (0 sem entrega escolhida). */
      shippingDiscountCents: number;
      /** "Confirmamos no fechamento…" quando algo depende de CPF/telefone/entrega; null quando não. */
      pendingNotice: string | null;
      /** Cupom que muda com o tempo ou da turma: "Hoje vale 10%…" / "Cupom da turma: 9% hoje…"; null nos demais. */
      hint: string | null;
      /** Cupom da turma: o texto para mandar a uma amiga (com o link /c/CÓDIGO); null nos demais. */
      shareText: string | null;
    }
  | { ok: false; error: string; errorCode?: string };

export async function quoteCouponAction(
  input: QuoteCouponActionInput,
): Promise<QuoteCouponActionResult> {
  try {
    const parsed = quoteCouponActionSchema.parse(input);
    const db = getDb();

    let identity: { documentDigits: string | null; phoneE164: string | null } | null = null;
    if (parsed.customer) {
      const document = normalizeDocument(parsed.customer.document);
      const phone = toE164BR(parsed.customer.phone);
      if (document && phone) identity = { documentDigits: document.digits, phoneE164: phone };
    }

    const quote = await quoteCoupon(db, {
      code: parsed.code,
      items: parsed.items,
      identity,
      shipping: parsed.shipping ?? null,
    });
    return {
      ok: true,
      code: quote.code,
      discountCents: quote.discountCents,
      freeShipping: quote.freeShipping,
      shippingDiscountCents: quote.shippingDiscountCents,
      pendingNotice: pendingNotice(quote.pending),
      hint: quote.hint,
      shareText: quote.shareText,
    };
  } catch (error) {
    if (error instanceof CouponServiceError) {
      return { ok: false, error: error.message, errorCode: error.code };
    }
    if (error instanceof ZodError) {
      return {
        ok: false,
        error: "Não foi possível aplicar o cupom: confira o código e a sacola.",
      };
    }
    return {
      ok: false,
      error: "Algo deu errado ao aplicar o cupom. Tente novamente.",
    };
  }
}
