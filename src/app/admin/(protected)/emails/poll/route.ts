// Poll da caixa de e-mail. Route handler NÃO herda o guard do layout
// (protected): a auth é interna e responde 401 em JSON, nunca redirect — do
// outro lado tem JavaScript esperando JSON, e um HTML de login viraria erro
// de parse. GET não muta nada; o "visto" vai por server action separada.
import { z } from "zod";

import { getDb } from "@/db/client";
import { getAuthUserOrNull } from "@/services/auth";
import {
  countThreadsAwaiting,
  getEmailThreadTail,
  listEmailThreads,
} from "@/services/email-inbox";
import { toInboxMessage, toInboxThreadItem } from "../serialize";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

const querySchema = z.object({
  c: z.uuid().optional(),
  ver: z.literal("arquivadas").optional(),
  light: z.literal("1").optional(),
});

/**
 * `?light=1` (crachá do menu, presente em qualquer página do painel): só a
 * contagem de conversas aguardando — pula as consultas pesadas de lista e de
 * conversa aberta.
 * Sem `light`: a lista da caixa escolhida (`?ver=arquivadas` para o arquivo)
 * mais a cauda da conversa aberta (`?c=<uuid>`).
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
    ver: url.searchParams.get("ver") ?? undefined,
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
  const awaitingCount = await countThreadsAwaiting(db);

  if (parsed.data.light === "1") {
    return Response.json({ serverTime, awaitingCount }, { headers: NO_STORE });
  }

  const box = parsed.data.ver === "arquivadas" ? "archived" : "open";
  const rows = await listEmailThreads(db, { status: box });
  const tail = parsed.data.c
    ? await getEmailThreadTail(db, { threadId: parsed.data.c })
    : null;

  return Response.json(
    {
      serverTime,
      awaitingCount,
      box,
      threads: rows.map(toInboxThreadItem),
      thread: tail
        ? {
            thread: {
              id: tail.thread.id,
              status: tail.thread.status,
              ownerLastSeenAt: tail.thread.ownerLastSeenAt
                ? tail.thread.ownerLastSeenAt.toISOString()
                : null,
            },
            messages: tail.messages.map(toInboxMessage),
          }
        : null,
    },
    { headers: NO_STORE },
  );
}
