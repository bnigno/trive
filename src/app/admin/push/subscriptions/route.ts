// Inscrição de Web Push deste aparelho. Route handler (não server action)
// porque o service worker também chama daqui quando o navegador renova a
// inscrição. Auth interna, sem redirect: quem chama espera JSON.
import { z } from "zod";

import { getDb } from "@/db/client";
import { getAuthUserOrNull } from "@/services/auth";
import { pushSubscriptionInputSchema, removePushSubscription, upsertPushSubscription } from "@/services/push-subscriptions";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<Response> {
  const user = await getAuthUserOrNull();
  if (!user) return Response.json({ error: "nao_autenticado" }, { status: 401, headers: NO_STORE });
  const parsed = pushSubscriptionInputSchema.safeParse(await readJson(request));
  if (!parsed.success) return Response.json({ error: "inscricao_invalida" }, { status: 400, headers: NO_STORE });
  const { id } = await upsertPushSubscription(getDb(), { userId: user.id, ...parsed.data });
  return Response.json({ ok: true, id }, { headers: NO_STORE });
}

const removeSchema = z.object({ endpoint: z.url({ protocol: /^https$/ }).max(2048) });

export async function DELETE(request: Request): Promise<Response> {
  const user = await getAuthUserOrNull();
  if (!user) return Response.json({ error: "nao_autenticado" }, { status: 401, headers: NO_STORE });
  const parsed = removeSchema.safeParse(await readJson(request));
  if (!parsed.success) return Response.json({ error: "inscricao_invalida" }, { status: 400, headers: NO_STORE });
  const { removed } = await removePushSubscription(getDb(), { userId: user.id, endpoint: parsed.data.endpoint });
  return Response.json({ ok: true, removed }, { headers: NO_STORE });
}
