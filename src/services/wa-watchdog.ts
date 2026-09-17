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
import { resolveBotMode } from "@/core/bot/copilot";
import { findInboundGaps, WATCHDOG, watchdogAlertBody, type WatchdogChat, type WatchdogGap, type WatchdogKnown } from "@/core/whatsapp/watchdog";
import { auditLog, users, waConversations, waMessages } from "@/db/schema";
import { toE164BR, toWaLid } from "@/lib/phone";
import type { DbOrTx } from "@/queue/enqueue";
import { isBotEnabled } from "@/services/wa-bot";
import { isWaEnabled, sendToOwner, siteBaseUrl } from "@/services/wa-messaging";
import { loadStoreBotMode } from "@/services/wa-suggestions";

const CHATS_LIMIT = 40;
const STORE_TIME_ZONE = "America/Sao_Paulo";
/** No máximo um aviso por chat por hora, mesmo com mensagens novas no meio. */
export const ALERT_COOLDOWN_PER_ADDRESS_MS = 60 * 60_000;

export type WaWatchdogResult =
  | { skipped: "desabilitado" | "sem_dono" | "envio_falhou" | "z-api_indisponivel"; error?: string }
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

  // Um chat pode ser conhecido pelo telefone OU pelo LID: o endereço da
  // conversa é qualquer um dos dois.
  const chats: WatchdogChat[] = [];
  const keysByAddress = new Map<string, string[]>();
  for (const chat of listed) {
    if (chat.isGroup) continue;
    const address = chatAddress(chat.phone);
    if (!address) continue;
    chats.push({ address, name: chat.name, lastMessageAt: chat.lastMessageAt, unread: chat.unread });
    const lid = toWaLid(chat.lid);
    keysByAddress.set(address, lid && lid !== address ? [address, lid] : [address]);
  }
  if (chats.length === 0) return { checked: 0, gaps: 0, alerted: 0, alreadyAlerted: 0 };

  // O que temos por endereço: última atividade (entrada/saída/mensagem), a
  // última RECEBIDA e se a Lia lê as recebidas nesta conversa (conversa
  // aberta, bot ligado, modo autônomo — o copiloto e o atendimento humano
  // não marcam lido).
  const since = new Date(now.getTime() - WATCHDOG.windowMs - WATCHDOG.toleranceMs);
  const rows = await db
    .select({
      id: waConversations.id,
      phoneE164: waConversations.phoneE164,
      lid: waConversations.lid,
      status: waConversations.status,
      botMode: waConversations.botMode,
      botDisabledUntil: waConversations.botDisabledUntil,
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
  const botEnabled = await isBotEnabled(db);
  const storeMode = await loadStoreBotMode(db);

  const byKey = new Map<string, WatchdogKnown>();
  const toDate = (value: Date | string | null | undefined): Date | null => (value ? (value instanceof Date ? value : new Date(value)) : null);
  const later = (a: Date | null, b: Date | null): Date | null => (!a ? b : !b ? a : a > b ? a : b);
  for (const row of rows) {
    const at = later(later(toDate(row.lastInboundAt), toDate(row.lastOutboundAt)), toDate(lastMessageByConversation.get(row.id)));
    if (!at) continue;
    const botReads =
      botEnabled &&
      row.status === "open" &&
      !(row.botDisabledUntil && row.botDisabledUntil.getTime() > now.getTime()) &&
      resolveBotMode(storeMode, row.botMode) === "autonomous";
    const entry: WatchdogKnown = { at, inboundAt: toDate(row.lastInboundAt), botReads };
    for (const key of [row.phoneE164, row.lid]) {
      if (!key) continue;
      const current = byKey.get(key);
      if (!current || current.at < at) byKey.set(key, entry);
    }
  }
  const known = new Map<string, WatchdogKnown>();
  for (const [address, keys] of keysByAddress) {
    let best: WatchdogKnown | null = null;
    for (const key of keys) {
      const entry = byKey.get(key);
      if (entry && (!best || entry.at > best.at)) best = entry;
    }
    if (best) known.set(address, best);
  }

  const gaps = findInboundGaps({ chats, known, now });
  if (gaps.length === 0) return { checked: chats.length, gaps: 0, alerted: 0, alreadyAlerted: 0 };

  // Só o que ainda não foi avisado: mesmo endereço com mensagem igual ou
  // mais nova já avisada, ou qualquer aviso desse endereço na última hora
  // (o dono digitando no celular da loja não vira 6 avisos por hora).
  const fresh: WatchdogGap[] = [];
  for (const gap of gaps) {
    const [last] = await db
      .select({ after: auditLog.after, createdAt: auditLog.createdAt })
      .from(auditLog)
      .where(and(eq(auditLog.action, "wa.watchdog_alert"), eq(auditLog.entityId, gap.address), isNotNull(auditLog.after)))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    const alertedAt = (last?.after as { lastMessageAt?: string } | null)?.lastMessageAt;
    if (alertedAt && new Date(alertedAt).getTime() >= gap.lastMessageAt.getTime()) continue;
    if (last && last.createdAt.getTime() > now.getTime() - ALERT_COOLDOWN_PER_ADDRESS_MS) continue;
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
    const failed = results.some((result) => result.status === "rejected");
    return { skipped: failed ? "envio_falhou" : "sem_dono", error: results.map((r) => (r.status === "rejected" ? String(r.reason) : String(r.value))).join(" | ") };
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
