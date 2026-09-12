"use server";
// "Falar com a Lia": grava a ponte (o que a cliente estava vendo) e devolve o
// link do WhatsApp com a mensagem pronta. A navegação acontece no cliente, na
// mesma aba (popup blocker do Safari) — por isso a action só devolve a URL.
import { z } from "zod";

import { BRIDGE_SOURCES } from "@/core/bot/site-bridge";
import { getDb } from "@/db/client";
import { createSiteCart } from "@/services/site-carts";

const schema = z.object({
  source: z.enum(BRIDGE_SOURCES),
  campaignSlug: z.string().trim().min(1).max(60).optional(),
  productSlug: z.string().trim().min(1).max(200).optional(),
  variantSku: z.string().trim().min(1).max(60).optional(),
  items: z.array(z.object({ sku: z.string().trim().min(1).max(60), quantity: z.number().int().min(1).max(20) })).max(20).optional(),
});

export type LiaBridgeResult = { ok: true; url: string } | { ok: false };

export async function startLiaBridgeAction(input: unknown): Promise<LiaBridgeResult> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false };
  try {
    const link = await createSiteCart(getDb(), parsed.data);
    return link.waUrl ? { ok: true, url: link.waUrl } : { ok: false };
  } catch (error) {
    console.error("[lia-bridge] falha ao abrir a ponte", error);
    return { ok: false };
  }
}
