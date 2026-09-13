"use server";
// "Me avisa quando a cortina abrir": telefone + consentimento explícito de
// UMA mensagem. Sem login: a identidade é o telefone (E.164). Honeypot
// silencioso contra robôs.
import { z } from "zod";

import { getDb } from "@/db/client";
import { toE164BR } from "@/lib/phone";
import { joinDropWaitlist } from "@/services/drop-waitlist";

const schema = z.object({
  dropId: z.uuid(),
  phone: z.string().trim().min(8, "Informe o seu WhatsApp."),
  consent: z.literal(true, { error: "Marque a caixinha para receber o aviso." }),
  /** Honeypot: humano deixa vazio. */
  website: z.string().max(0).optional(),
});

export type DropWaitlistResult = { ok: true; created: boolean } | { ok: false; message: string };

export async function joinDropWaitlistAction(input: {
  dropId: string;
  phone: string;
  consent: boolean;
  website?: string;
}): Promise<DropWaitlistResult> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Confira os dados." };
  }
  if (parsed.data.website) return { ok: true, created: false };
  const phoneE164 = toE164BR(parsed.data.phone);
  if (!phoneE164) return { ok: false, message: "Informe um WhatsApp válido com DDD." };
  try {
    const result = await joinDropWaitlist(getDb(), { dropId: parsed.data.dropId, phoneE164, source: "site" });
    if (result.reason === "sem_estreia") {
      return { ok: false, message: "Essa estreia já abriu (ou saiu de cartaz). Recarregue a página." };
    }
    return { ok: true, created: result.created };
  } catch (error) {
    console.error("joinDropWaitlistAction", error);
    return { ok: false, message: "Não deu para registrar agora. Tente de novo em instantes." };
  }
}
