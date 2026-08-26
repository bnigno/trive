// Poll do chat do admin. Route handler NÃO herda o guard do layout
// (protected): a auth é interna, sem redirect — cliente JS espera JSON.
// GET nunca muta nada; o "visto" vai por server action separada.
import { z } from "zod";

import { getDb } from "@/db/client";
import { getAuthUserOrNull } from "@/services/auth";
import {
  countConversationsAwaitingOwner,
  getWaThreadTail,
  listConversationsAwaitingOwner,
  listWaConversations,
} from "@/services/wa-conversations";
import { maskPhone } from "../format";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

const querySchema = z.object({
  c: z.uuid().optional(),
  light: z.literal("1").optional(),
});

/**
 * `?light=1` (badge/toast em qualquer página do admin): só a contagem e as
 * conversas aguardando o dono — pula as queries pesadas de lista e thread.
 * Sem `light`: lista completa + cauda da thread aberta (`?c=<uuid>`).
 * Datas saem como ISO 8601 (serialização JSON de Date).
 */
export async function GET(request: Request): Promise<Response> {
  const user = await getAuthUserOrNull();
  if (!user) {
    return Response.json(
      { error: "nao_autenticado" },
      { status: 401, headers: NO_STORE },
    );
  }

  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    c: url.searchParams.get("c") ?? undefined,
    light: url.searchParams.get("light") ?? undefined,
  });
  if (!parsed.success) {
    return Response.json(
      { error: "parametros_invalidos" },
      { status: 400, headers: NO_STORE },
    );
  }

  const db = getDb();
  const serverTime = new Date().toISOString();
  const humanCount = await countConversationsAwaitingOwner(db);

  if (parsed.data.light === "1") {
    const awaiting = await listConversationsAwaitingOwner(db);
    return Response.json(
      {
        serverTime,
        humanCount,
        awaiting: awaiting.map((conversation) => ({
          id: conversation.id,
          label:
            conversation.customerName ?? maskPhone(conversation.phoneE164),
        })),
      },
      { headers: NO_STORE },
    );
  }

  const conversations = await listWaConversations(db);
  const thread = parsed.data.c
    ? await getWaThreadTail(db, { conversationId: parsed.data.c })
    : null;

  return Response.json(
    { serverTime, humanCount, conversations, thread },
    { headers: NO_STORE },
  );
}
