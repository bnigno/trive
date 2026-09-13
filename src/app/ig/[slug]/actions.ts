"use server";
// O toque no link de story: grava a ponte (source 'campaign') e devolve o
// WhatsApp com a mensagem pronta. A navegação é do cliente (mesma aba).
import { z } from "zod";

import { getDb } from "@/db/client";
import { tapCampaignLink } from "@/services/campaign-links";

const schema = z.object({ slug: z.string().trim().min(1).max(80) });

export type TapCampaignResult = { ok: true; url: string } | { ok: false };

export async function tapCampaignLinkAction(input: unknown): Promise<TapCampaignResult> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false };
  try {
    const link = await tapCampaignLink(getDb(), parsed.data);
    return link?.waUrl ? { ok: true, url: link.waUrl } : { ok: false };
  } catch (error) {
    console.error("[ig] falha ao registrar o toque", error);
    return { ok: false };
  }
}
