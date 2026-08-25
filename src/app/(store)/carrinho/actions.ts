"use server";

// Cotação de frete do carrinho: o CLIENTE só manda variantId + quantidade;
// os pesos vêm do banco (nunca do cliente) e o preço de cada opção vem da
// tabela shipping_rates via quoteShipping.

import { inArray } from "drizzle-orm";
import { z, ZodError } from "zod";

import { getDb } from "@/db/client";
import { productVariants } from "@/db/schema";
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
