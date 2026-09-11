"use server";
// "Me avisa quando voltar" na página da peça: telefone + consentimento
// explícito de UMA mensagem. Sem login: a identidade é o telefone (E.164),
// como no checkout e no WhatsApp. Honeypot silencioso contra robôs.
import { z } from "zod";

import { getDb } from "@/db/client";
import { toE164BR } from "@/lib/phone";
import { requestStockAlert } from "@/services/stock-alerts";

const schema = z.object({
  variantId: z.uuid(),
  phone: z.string().trim().min(8, "Informe o seu WhatsApp."),
  consent: z.literal(true, { error: "Marque a caixinha para receber o aviso." }),
  /** Honeypot: humano deixa vazio. */
  website: z.string().max(0).optional(),
});

export type RestockAlertResult =
  | { ok: true; created: boolean }
  | { ok: false; message: string };

export async function requestStockAlertAction(input: {
  variantId: string;
  phone: string;
  consent: boolean;
  website?: string;
}): Promise<RestockAlertResult> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Confira os dados." };
  }
  if (parsed.data.website) return { ok: true, created: false };
  const phoneE164 = toE164BR(parsed.data.phone);
  if (!phoneE164) return { ok: false, message: "Informe um WhatsApp válido com DDD." };
  try {
    const result = await requestStockAlert(getDb(), {
      variantId: parsed.data.variantId,
      phoneE164,
      source: "site",
    });
    return { ok: true, created: result.created };
  } catch (error) {
    console.error("requestStockAlertAction", error);
    return { ok: false, message: "Não deu para registrar agora. Tente de novo em instantes." };
  }
}
