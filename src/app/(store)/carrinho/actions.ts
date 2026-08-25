"use server";

// Cotação de frete do carrinho: o CLIENTE só manda variantId + quantidade;
// os pesos vêm do banco (nunca do cliente) e o preço de cada opção vem da
// tabela shipping_rates via quoteShipping.

import { and, eq, inArray } from "drizzle-orm";
import { z, ZodError } from "zod";

import { getDb } from "@/db/client";
import { priceVersions, productVariants } from "@/db/schema";
import {
  quoteCoupon,
  ServiceError as CouponServiceError,
} from "@/services/coupons";
import {
  computeTotalWeightGrams,
  quoteShipping,
  ServiceError,
  type ShippingQuote,
} from "@/services/store-catalog";
import { getSettingsMap } from "@/services/settings";

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
      quotes: ShippingQuote[];
      /** Link wa.me quando store_whatsapp está configurado; null caso contrário. */
      whatsappUrl: string | null;
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

    const quotes = await quoteShipping(db, { cep: parsed.cep, totalWeightGrams });

    // Só precisamos do WhatsApp quando não há opção de entrega, mas ler a
    // setting é barato e evita uma segunda action.
    let whatsappUrl: string | null = null;
    const settings = await getSettingsMap(db, ["store_whatsapp"]);
    const whatsapp = settings["store_whatsapp"];
    if (typeof whatsapp === "string") {
      const digits = whatsapp.replace(/\D/g, "");
      if (digits.length >= 10) whatsappUrl = `https://wa.me/${digits}`;
    }

    return { ok: true, quotes, whatsappUrl };
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
// Cupom de desconto: o cliente manda só o código + variantId/quantidade.
// O subtotal é recalculado AQUI com os preços ATIVOS do banco (nunca os do
// cliente) e o serviço de cupons valida vigência/mínimo/limite de usos.
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
});

export type QuoteCouponActionInput = z.input<typeof quoteCouponActionSchema>;

export type QuoteCouponActionResult =
  | {
      ok: true;
      /** Código normalizado (UPPERCASE), como será gravado no pedido. */
      code: string;
      discountCents: number;
    }
  | { ok: false; error: string };

export async function quoteCouponAction(
  input: QuoteCouponActionInput,
): Promise<QuoteCouponActionResult> {
  try {
    const parsed = quoteCouponActionSchema.parse(input);
    const db = getDb();

    // Preços ativos das variantes direto do banco; variante sem preço ativo
    // não soma (o checkout vai barrá-la de qualquer forma com NO_ACTIVE_PRICE).
    const variantIds = parsed.items.map((item) => item.variantId);
    const rows = await db
      .select({
        variantId: priceVersions.productVariantId,
        priceCents: priceVersions.priceCents,
      })
      .from(priceVersions)
      .where(
        and(
          inArray(priceVersions.productVariantId, variantIds),
          eq(priceVersions.status, "active"),
        ),
      );
    const priceByVariant = new Map(
      rows.map((row) => [row.variantId, row.priceCents]),
    );

    const subtotalCents = parsed.items.reduce(
      (sum, item) =>
        sum + (priceByVariant.get(item.variantId) ?? 0) * item.quantity,
      0,
    );

    const quote = await quoteCoupon(db, {
      code: parsed.code,
      subtotalCents,
    });
    return { ok: true, code: quote.code, discountCents: quote.discountCents };
  } catch (error) {
    if (error instanceof CouponServiceError) {
      return { ok: false, error: error.message };
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
