// "Me avisa quando a cortina abrir": a lista de espera da estreia pública.
// Entrar é idempotente (UNIQUE parcial por lançamento + telefone); ao
// publicar, drop.published vira um wa.drop_open_notify por linha, escalonado
// dentro da janela de envio; quem deu SAIR não recebe nem o que pediu.

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { MessagingProvider } from "@/adapters/zapi";
import { dropPhase } from "@/core/drops";
import { staggerWithinWindow } from "@/core/whatsapp/send-window";
import { auditLog, customers, dropProducts, dropWaitlist, drops, products, waTemplates } from "@/db/schema";
import { siteUrl } from "@/lib/site-url";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";
import { deferOutsideSendWindow, loadSendPolicy } from "@/services/wa-send-policy";
import { firstNameOf, isWaEnabled, sendTemplateMessage, type SendWaMessageResult } from "@/services/wa-messaging";

export const DROP_OPEN_TEMPLATE_KEY = "drop_open";
export const DROP_WAITLIST_EVENT = "wa.drop_open_notify";

const E164 = /^\+[1-9]\d{7,14}$/;

const joinSchema = z.object({
  dropId: z.uuid(),
  phoneE164: z.string().regex(E164, "Telefone inválido."),
  customerId: z.uuid().optional(),
  source: z.enum(["site", "lia", "admin"]).default("site"),
});
export type JoinDropWaitlistInput = z.input<typeof joinSchema>;

/**
 * Entra na lista (uma vez por telefone e lançamento aberto). Só lançamentos
 * agendados aceitam: rascunho, cancelado ou já publicado não têm o que avisar.
 */
export async function joinDropWaitlist(
  db: DbOrTx,
  input: JoinDropWaitlistInput,
  now = new Date(),
): Promise<{ created: boolean; waitlistId: string | null; reason?: "sem_estreia" }> {
  const parsed = joinSchema.parse(input);
  const [drop] = await db
    .select({ status: drops.status, publishAt: drops.publishAt, vipWindowHours: drops.vipWindowHours })
    .from(drops)
    .where(eq(drops.id, parsed.dropId))
    .limit(1);
  if (!drop) return { created: false, waitlistId: null, reason: "sem_estreia" };
  const phase = dropPhase(drop, now);
  if (phase !== "scheduled" && phase !== "vip") return { created: false, waitlistId: null, reason: "sem_estreia" };

  let customerId = parsed.customerId ?? null;
  if (!customerId) {
    const [customer] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.phoneE164, parsed.phoneE164), isNull(customers.deletedAt)))
      .limit(1);
    customerId = customer?.id ?? null;
  }

  const inserted = await db
    .insert(dropWaitlist)
    .values({ dropId: parsed.dropId, phoneE164: parsed.phoneE164, customerId, source: parsed.source, consentAt: now })
    .onConflictDoNothing()
    .returning({ id: dropWaitlist.id });
  const row = inserted[0];
  if (!row) return { created: false, waitlistId: null };

  await db.insert(auditLog).values({
    actorType: parsed.source === "admin" ? "user" : "customer",
    actorId: customerId,
    action: "drop.waitlist_join",
    entityType: "drop",
    entityId: parsed.dropId,
    after: { waitlistId: row.id, phoneE164: parsed.phoneE164, source: parsed.source },
  });
  return { created: true, waitlistId: row.id };
}

export type DropWaitlistCount = { total: number; notified: number; open: number };

/** Quantas pediram aviso (e quantas já receberam) num lançamento. */
export async function countDropWaitlist(db: DbOrTx, dropId: string): Promise<DropWaitlistCount> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      notified: sql<number>`count(${dropWaitlist.notifiedAt})::int`,
      open: sql<number>`count(*) filter (where ${dropWaitlist.notifiedAt} is null and ${dropWaitlist.canceledAt} is null)::int`,
    })
    .from(dropWaitlist)
    .where(eq(dropWaitlist.dropId, dropId));
  return { total: Number(row?.total ?? 0), notified: Number(row?.notified ?? 0), open: Number(row?.open ?? 0) };
}

/**
 * Handler de drop.published: um wa.drop_open_notify por linha aberta, com
 * next_attempt_at escalonado a partir da abertura da janela — nunca uma
 * rajada. Idempotente pelo dedupe por linha.
 */
export async function fanOutDropWaitlist(db: DbOrTx, input: { dropId: string; now?: Date }): Promise<{ queued: number }> {
  const now = input.now ?? new Date();
  const open = await db
    .select({ id: dropWaitlist.id })
    .from(dropWaitlist)
    .where(and(eq(dropWaitlist.dropId, input.dropId), isNull(dropWaitlist.notifiedAt), isNull(dropWaitlist.canceledAt)))
    .orderBy(dropWaitlist.createdAt);
  if (open.length === 0) return { queued: 0 };
  const policy = await loadSendPolicy(db);
  // A fila não atravessa o fim da janela: a cauda continua amanhã às 9h, no
  // mesmo passo — nunca uma rajada na manhã seguinte.
  const schedule = staggerWithinWindow(open.length, { from: now, intervalSeconds: policy.intervalSeconds, window: policy.window });
  let queued = 0;
  for (const [index, row] of open.entries()) {
    const id = await enqueueOutboxEvent(db, {
      eventType: DROP_WAITLIST_EVENT,
      dedupeKey: `${DROP_WAITLIST_EVENT}:${row.id}`,
      aggregateType: "drop_waitlist",
      aggregateId: row.id,
      payload: { waitlistId: row.id, dropId: input.dropId },
      nextAttemptAt: schedule[index],
    });
    if (id) queued += 1;
  }
  return { queued };
}

export type NotifyDropOpenResult =
  | SendWaMessageResult
  | { skipped: "inexistente" | "ja_avisado" | "nao_publicado" | "fora_da_janela" | "sem_opt_in" | "sem_template" };

/**
 * Handler de wa.drop_open_notify: manda o template drop_open para uma linha
 * da lista. Confere, nesta ordem: linha, já avisada, lançamento aberto,
 * WhatsApp ligado, janela (adia com dedupe datado), SAIR, template ativo.
 */
export async function notifyDropOpen(
  db: DbOrTx,
  provider: MessagingProvider,
  input: { waitlistId: string; now?: Date },
): Promise<NotifyDropOpenResult> {
  const now = input.now ?? new Date();
  const [row] = await db
    .select({
      id: dropWaitlist.id,
      dropId: dropWaitlist.dropId,
      phoneE164: dropWaitlist.phoneE164,
      customerId: dropWaitlist.customerId,
      notifiedAt: dropWaitlist.notifiedAt,
      canceledAt: dropWaitlist.canceledAt,
      consentAt: dropWaitlist.consentAt,
      dropName: drops.name,
      dropStatus: drops.status,
      publishAt: drops.publishAt,
      vipWindowHours: drops.vipWindowHours,
    })
    .from(dropWaitlist)
    .innerJoin(drops, eq(drops.id, dropWaitlist.dropId))
    .where(eq(dropWaitlist.id, input.waitlistId))
    .limit(1);
  if (!row) return { skipped: "inexistente" };
  if (row.notifiedAt || row.canceledAt) return { skipped: "ja_avisado" };
  if (dropPhase({ status: row.dropStatus, publishAt: row.publishAt, vipWindowHours: row.vipWindowHours }, now) !== "published") {
    return { skipped: "nao_publicado" };
  }
  if (!(await isWaEnabled(db))) return { skipped: "desabilitado" };

  const policy = await loadSendPolicy(db);
  const deferred = await deferOutsideSendWindow(db, policy, {
    eventType: DROP_WAITLIST_EVENT,
    dedupeBase: `${DROP_WAITLIST_EVENT}:${row.id}`,
    aggregateType: "drop_waitlist",
    aggregateId: row.id,
    payload: { waitlistId: row.id, dropId: row.dropId },
    now,
  });
  if (deferred) return { skipped: "fora_da_janela" };

  // Quem deu SAIR não recebe nem o aviso que pediu: cancela em silêncio.
  const [customer] = await db
    .select({ id: customers.id, fullName: customers.fullName, marketingOptIn: customers.marketingOptIn })
    .from(customers)
    .where(row.customerId ? eq(customers.id, row.customerId) : and(eq(customers.phoneE164, row.phoneE164), isNull(customers.deletedAt)))
    .limit(1);
  if (customer && !customer.marketingOptIn) {
    const [optOut] = await db
      .select({ createdAt: auditLog.createdAt })
      .from(auditLog)
      .where(and(eq(auditLog.action, "wa.opt_out"), eq(auditLog.entityId, customer.id)))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    // SAIR depois de pedir o aviso cancela; a caixinha marcada DEPOIS de um
    // SAIR antigo é consentimento novo e vale.
    if (optOut && optOut.createdAt.getTime() >= row.consentAt.getTime()) {
      await db.update(dropWaitlist).set({ canceledAt: now }).where(eq(dropWaitlist.id, row.id));
      return { skipped: "sem_opt_in" };
    }
  }

  const [template] = await db
    .select({ isActive: waTemplates.isActive })
    .from(waTemplates)
    .where(eq(waTemplates.key, DROP_OPEN_TEMPLATE_KEY))
    .limit(1);
  if (!template?.isActive) return { skipped: "sem_template" };

  const pieces = await db
    .select({ name: products.name })
    .from(dropProducts)
    .innerJoin(products, eq(products.id, dropProducts.productId))
    .where(eq(dropProducts.dropId, row.dropId))
    .orderBy(products.name)
    .limit(3);
  const names = pieces.map((p) => p.name);
  const pecas = names.length === 0 ? "as peças novas" : names.length <= 2 ? names.join(" e ") : `${names[0]}, ${names[1]} e mais`;

  const result = await sendTemplateMessage(db, provider, {
    templateKey: DROP_OPEN_TEMPLATE_KEY,
    phoneE164: row.phoneE164,
    vars: {
      nome: customer?.fullName ? firstNameOf(customer.fullName) : "Oi",
      lancamento: row.dropName,
      pecas,
      link: `${siteUrl()}/estreia`,
    },
    ...(customer ? { customerId: customer.id } : {}),
    dedupeKey: `wa.drop_open:${row.id}`,
    requireOptIn: false,
  });

  if ("sent" in result) {
    await db.update(dropWaitlist).set({ notifiedAt: now, notifiedWaMessageId: result.waMessageId }).where(eq(dropWaitlist.id, row.id));
  } else if (result.skipped === "ja_enviado") {
    await db.update(dropWaitlist).set({ notifiedAt: now }).where(and(eq(dropWaitlist.id, row.id), isNull(dropWaitlist.notifiedAt)));
  }
  return result;
}

/** As últimas entradas (painel do lançamento). */
export async function listDropWaitlist(db: DbOrTx, dropId: string, limit = 20) {
  return db
    .select({ id: dropWaitlist.id, phoneE164: dropWaitlist.phoneE164, createdAt: dropWaitlist.createdAt, notifiedAt: dropWaitlist.notifiedAt, canceledAt: dropWaitlist.canceledAt })
    .from(dropWaitlist)
    .where(eq(dropWaitlist.dropId, dropId))
    .orderBy(desc(dropWaitlist.createdAt))
    .limit(limit);
}

/**
 * SAIR pelo WhatsApp: toda linha aberta desse telefone é cancelada — também
 * de quem nunca teve cadastro (a /estreia é sem login). Devolve quantas.
 */
export async function cancelDropWaitlistByPhone(db: DbOrTx, phoneE164: string, now = new Date()): Promise<number> {
  const rows = await db
    .update(dropWaitlist)
    .set({ canceledAt: now })
    .where(and(eq(dropWaitlist.phoneE164, phoneE164), isNull(dropWaitlist.notifiedAt), isNull(dropWaitlist.canceledAt)))
    .returning({ id: dropWaitlist.id });
  return rows.length;
}
