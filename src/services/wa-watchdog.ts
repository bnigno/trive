// Vigia do WhatsApp (cron de 10 min): compara os chats que a Z-API tem com
// o que o sistema registrou e AVISA o dono de cada buraco — pelo WhatsApp
// dele (o envio costuma funcionar mesmo quando o webhook falha) e por
// e-mail. Um mesmo buraco (endereço + hora da mensagem) avisa uma vez só:
// o dedupe fica no audit_log ('wa.watchdog_alert', entity_id = endereço).
// Nunca lança: uma falha aqui não pode virar mais uma rotina falhando em
// silêncio — o retorno explica o que houve no painel do Inngest.
import { and, desc, eq, gt, isNotNull, max } from "drizzle-orm";

import { getEmailProvider, isEmailConfigured, type EmailProvider } from "@/adapters/email";
import type { MessagingProvider } from "@/adapters/zapi";
import { findInboundGaps, WATCHDOG, watchdogAlertBody, type WatchdogChat, type WatchdogGap } from "@/core/whatsapp/watchdog";
import { auditLog, users, waConversations, waMessages } from "@/db/schema";
import { toE164BR, toWaLid } from "@/lib/phone";
import type { DbOrTx } from "@/queue/enqueue";
import { isWaEnabled, sendToOwner, siteBaseUrl } from "@/services/wa-messaging";

const CHATS_LIMIT = 40;
const STORE_TIME_ZONE = "America/Sao_Paulo";

export type WaWatchdogResult =
  | { skipped: "desabilitado" | "sem_dono" | "z-api_indisponivel"; error?: string }
  | { checked: number; gaps: number; alerted: number; alreadyAlerted: number };

/** Telefone da Z-API ('5591…') ou LID → o endereço que a conversa guarda. */
export function chatAddress(phone: string): string | null {
  return toWaLid(phone) ?? toE164BR(phone) ?? (/^\d{8,15}$/.test(phone) ? `+${phone}` : null);
}

export async function checkInboundGapsAndAlert(
  db: DbOrTx,
  provider: MessagingProvider,
  options: { now?: Date; emailProvider?: EmailProvider } = {},
): Promise<WaWatchdogResult> {
  if (!(await isWaEnabled(db))) return { skipped: "desabilitado" };
  const now = options.now ?? new Date();

  let listed;
  try {
    listed = await provider.listRecentChats(CHATS_LIMIT);
  } catch (error) {
    return { skipped: "z-api_indisponivel", error: error instanceof Error ? error.message : String(error) };
  }

  const chats: WatchdogChat[] = [];
  for (const chat of listed) {
    if (chat.isGroup) continue;
    const address = chatAddress(chat.phone);
    if (!address) continue;
    chats.push({ address, name: chat.name, lastMessageAt: chat.lastMessageAt });
  }
  if (chats.length === 0) return { checked: 0, gaps: 0, alerted: 0, alreadyAlerted: 0 };

  // A última atividade que temos por endereço: entrada/saída da conversa e
  // a mensagem mais recente (qualquer direção), pelo telefone OU pelo LID.
  const known = new Map<string, Date>();
  const since = new Date(now.getTime() - WATCHDOG.windowMs - WATCHDOG.toleranceMs);
  const rows = await db
    .select({
      id: waConversations.id,
      phoneE164: waConversations.phoneE164,
      lid: waConversations.lid,
      lastInboundAt: waConversations.lastInboundAt,
      lastOutboundAt: waConversations.lastOutboundAt,
    })
    .from(waConversations)
    .where(gt(waConversations.updatedAt, since));
  const recentMessages = await db
    .select({ conversationId: waMessages.conversationId, lastAt: max(waMessages.createdAt) })
    .from(waMessages)
    .where(gt(waMessages.createdAt, since))
    .groupBy(waMessages.conversationId);
  const lastMessageByConversation = new Map(recentMessages.map((row) => [row.conversationId, row.lastAt]));
  const bump = (key: string | null, date: Date | string | null | undefined) => {
    if (!key || !date) return;
    const at = date instanceof Date ? date : new Date(date);
    const current = known.get(key);
    if (!current || current < at) known.set(key, at);
  };
  for (const row of rows) {
    for (const key of [row.phoneE164, row.lid]) {
      bump(key, row.lastInboundAt);
      bump(key, row.lastOutboundAt);
      bump(key, lastMessageByConversation.get(row.id));
    }
  }

  const gaps = findInboundGaps({ chats, known, now });
  if (gaps.length === 0) return { checked: chats.length, gaps: 0, alerted: 0, alreadyAlerted: 0 };

  // Só o que ainda não foi avisado (mesmo endereço, mensagem igual ou mais nova).
  const fresh: WatchdogGap[] = [];
  for (const gap of gaps) {
    const [last] = await db
      .select({ after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.action, "wa.watchdog_alert"), eq(auditLog.entityId, gap.address), isNotNull(auditLog.after)))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    const alertedAt = (last?.after as { lastMessageAt?: string } | null)?.lastMessageAt;
    if (alertedAt && new Date(alertedAt).getTime() >= gap.lastMessageAt.getTime()) continue;
    fresh.push(gap);
  }
  if (fresh.length === 0) return { checked: chats.length, gaps: gaps.length, alerted: 0, alreadyAlerted: gaps.length };

  const body = watchdogAlertBody(fresh, STORE_TIME_ZONE);
  const results = await Promise.allSettled([
    sendToOwner(db, provider, { bodyOverride: body, dedupeKey: `wa.watchdog:${fresh[0].address}:${fresh[0].lastMessageAt.getTime()}` }).then(
      (result) => "sent" in result && result.sent,
    ),
    emailOwner(db, options.emailProvider ?? getEmailProvider(), body),
  ]);
  const delivered = results.some((result) => result.status === "fulfilled" && result.value === true);
  if (!delivered) {
    return { skipped: "sem_dono", error: results.map((r) => (r.status === "rejected" ? String(r.reason) : String(r.value))).join(" | ") };
  }

  for (const gap of fresh) {
    await db.insert(auditLog).values({
      actorType: "system",
      actorId: null,
      action: "wa.watchdog_alert",
      entityType: "wa_conversation",
      entityId: gap.address,
      after: { name: gap.name, lastMessageAt: gap.lastMessageAt.toISOString(), knownAt: gap.knownAt?.toISOString() ?? null },
      createdAt: now,
    });
  }
  return { checked: chats.length, gaps: gaps.length, alerted: fresh.length, alreadyAlerted: gaps.length - fresh.length };
}

async function emailOwner(db: DbOrTx, emailProvider: EmailProvider, body: string): Promise<boolean> {
  if (!isEmailConfigured()) return false;
  const [owner] = await db
    .select({ email: users.email })
    .from(users)
    .where(and(eq(users.role, "owner"), eq(users.isActive, true)))
    .limit(1);
  if (!owner) return false;
  const adminUrl = `${siteBaseUrl()}/admin/whatsapp/conversas`;
  await emailProvider.send({
    to: owner.email,
    subject: "WhatsApp: mensagem que não chegou ao sistema",
    text: `${body}\n\nConversas: ${adminUrl}`,
    html: `<pre style="font-family:inherit;white-space:pre-wrap">${escapeHtml(body)}</pre><p><a href="${adminUrl}">Abrir as conversas</a></p>`,
  });
  return true;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}
