// Inscrições de Web Push do painel (um aparelho = uma inscrição, presa ao
// usuário). O endpoint identifica a inscrição: o mesmo endpoint de novo
// (renovação, outro usuário logado no mesmo navegador) reaproveita a linha.
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { pushSubscriptions, users } from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";

// O que o navegador entrega em PushSubscription.toJSON(): endpoint https e
// as duas chaves em base64url. Parse, não cast (fronteira de rede).
const base64url = z.string().min(16).max(512).regex(/^[A-Za-z0-9_-]+=*$/);

export const pushSubscriptionInputSchema = z.object({
  endpoint: z.url({ protocol: /^https$/ }).max(2048),
  keys: z.object({ p256dh: base64url, auth: base64url }),
  userAgent: z.string().max(300).nullish(),
});
export type PushSubscriptionInput = z.input<typeof pushSubscriptionInputSchema>;

export async function upsertPushSubscription(
  db: DbOrTx,
  input: { userId: string } & PushSubscriptionInput,
): Promise<{ id: string }> {
  const parsed = pushSubscriptionInputSchema.parse(input);
  const [row] = await db
    .insert(pushSubscriptions)
    .values({
      userId: input.userId,
      endpoint: parsed.endpoint,
      p256dh: parsed.keys.p256dh,
      auth: parsed.keys.auth,
      userAgent: parsed.userAgent ?? null,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        userId: input.userId,
        p256dh: parsed.keys.p256dh,
        auth: parsed.keys.auth,
        userAgent: parsed.userAgent ?? null,
        updatedAt: new Date(),
        lastError: null,
      },
    })
    .returning({ id: pushSubscriptions.id });
  return { id: row.id };
}

/** Desligar neste aparelho: só o dono da inscrição apaga a própria. */
export async function removePushSubscription(db: DbOrTx, input: { userId: string; endpoint: string }): Promise<{ removed: boolean }> {
  const removed = await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, input.userId), eq(pushSubscriptions.endpoint, input.endpoint)))
    .returning({ id: pushSubscriptions.id });
  return { removed: removed.length > 0 };
}

export async function hasPushSubscription(db: DbOrTx, input: { userId: string; endpoint: string }): Promise<boolean> {
  const [row] = await db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, input.userId), eq(pushSubscriptions.endpoint, input.endpoint)))
    .limit(1);
  return row !== undefined;
}

export interface ActivePushSubscription {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Todas as inscrições de usuários ativos do painel — o aviso vai para todo mundo que ligou. */
export async function listActivePushSubscriptions(db: DbOrTx): Promise<ActivePushSubscription[]> {
  return await db
    .select({
      id: pushSubscriptions.id,
      userId: pushSubscriptions.userId,
      endpoint: pushSubscriptions.endpoint,
      p256dh: pushSubscriptions.p256dh,
      auth: pushSubscriptions.auth,
    })
    .from(pushSubscriptions)
    .innerJoin(users, eq(users.id, pushSubscriptions.userId))
    .where(eq(users.isActive, true))
    .orderBy(pushSubscriptions.createdAt);
}

/** Alguém ligou o aviso em algum aparelho? Sem isso a inbound nem enfileira o push. */
export async function hasAnyActivePushSubscription(db: DbOrTx): Promise<boolean> {
  const [row] = await db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .innerJoin(users, eq(users.id, pushSubscriptions.userId))
    .where(eq(users.isActive, true))
    .limit(1);
  return row !== undefined;
}

export async function countPushSubscriptionsByUser(db: DbOrTx, userId: string): Promise<number> {
  const rows = await db.select({ id: pushSubscriptions.id }).from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
  return rows.length;
}
