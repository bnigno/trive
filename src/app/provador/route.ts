// A porta de entrada do Provador: trivemaison.com.br/provador (QR no vale de
// papel e no adesivo da sacola, link no story e no grupo antigo) leva ao
// WhatsApp da Lia com a mensagem pronta — é ela quem pede o tamanho, o sim
// para os avisos e entrega o convite. Sem o número da loja, cai na home.
import { redirect } from "next/navigation";

import { getDb } from "@/db/client";
import { provadorEntryUrl } from "@/services/wa-groups";

export const dynamic = "force-dynamic";

export async function GET(): Promise<never> {
  const url = await provadorEntryUrl(getDb());
  redirect(url ?? "/");
}
