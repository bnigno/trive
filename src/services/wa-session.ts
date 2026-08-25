// Sessão do WhatsApp (Z-API): visão para o admin (/admin/whatsapp) e
// monitoramento por cron. A sessão cair NÃO perde mensagem nenhuma — tudo
// sai pela fila outbox e acumula até a reconexão; aqui só ENXERGAMOS o estado
// e avisamos o dono por E-Mail (o WhatsApp está fora do ar, afinal).
import { and, count, desc, eq, gt, inArray } from "drizzle-orm";

import { getAdapterMode } from "@/adapters/adapter-mode";
import { getEmailProvider, type EmailProvider } from "@/adapters/email";
import type { MessagingProvider } from "@/adapters/zapi";
import { auditLog, users, waConversations, waMessages } from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { isWaEnabled, siteBaseUrl } from "@/services/wa-messaging";

export interface WaSessionMessageSummary {
  id: string;
  phoneE164: string;
  direction: string;
  status: string;
  body: string;
  templateKey: string | null;
  createdAt: Date;
}

export interface WaSessionOverview {
  enabled: boolean;
  connected: boolean;
  /** QR code para parear — presente apenas quando desconectado. */
  qrImageBase64?: string;
  /** Mensagens aguardando entrega (queued) ou a serem retomadas (failed). */
  queuedCount: number;
  lastMessages: WaSessionMessageSummary[];
}

export async function getWaSessionOverview(
  db: DbOrTx,
  provider: MessagingProvider,
): Promise<WaSessionOverview> {
  const enabled = await isWaEnabled(db);
  const status = await provider.getSessionStatus();

  let qrImageBase64: string | undefined;
  if (!status.connected) {
    const qr = await provider.getQrCode();
    qrImageBase64 = qr?.imageBase64;
  }

  const [queued] = await db
    .select({ value: count() })
    .from(waMessages)
    .where(inArray(waMessages.status, ["queued", "failed"]));

  const lastMessages = await db
    .select({
      id: waMessages.id,
      phoneE164: waConversations.phoneE164,
      direction: waMessages.direction,
      status: waMessages.status,
      body: waMessages.body,
      templateKey: waMessages.templateKey,
      createdAt: waMessages.createdAt,
    })
    .from(waMessages)
    .innerJoin(waConversations, eq(waConversations.id, waMessages.conversationId))
    .orderBy(desc(waMessages.createdAt))
    .limit(20);

  return {
    enabled,
    connected: status.connected,
    ...(qrImageBase64 ? { qrImageBase64 } : {}),
    queuedCount: queued?.value ?? 0,
    lastMessages,
  };
}

// ---------------------------------------------------------------------------
// checkSessionAndAlert — cron a cada 5 min. Sessão caída + WhatsApp habilitado
// → e-mail ao dono (users role 'owner') com link para reconectar, no máximo
// 1x por hora (dedupe simples via audit 'wa.session_alert').
// ---------------------------------------------------------------------------

const ALERT_COOLDOWN_MS = 60 * 60_000;

export async function checkSessionAndAlert(
  db: DbOrTx,
  provider: MessagingProvider,
  emailProvider: EmailProvider = getEmailProvider(),
): Promise<{ connected: boolean }> {
  if (!(await isWaEnabled(db))) return { connected: false };

  const status = await provider.getSessionStatus();
  if (status.connected) return { connected: true };

  const cooldownStart = new Date(Date.now() - ALERT_COOLDOWN_MS);
  const [recentAlert] = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "wa.session_alert"),
        gt(auditLog.createdAt, cooldownStart),
      ),
    )
    .limit(1);
  if (recentAlert) return { connected: false };

  const [owner] = await db
    .select({ email: users.email })
    .from(users)
    .where(and(eq(users.role, "owner"), eq(users.isActive, true)))
    .limit(1);
  if (!owner) return { connected: false };

  const adminUrl = `${siteBaseUrl()}/admin/whatsapp`;
  // Sem Resend configurado em modo real, não há como avisar por e-mail —
  // o alerta fica só no banner do /admin/whatsapp (skip silencioso, sem
  // poluir o cron com falhas a cada 5 minutos).
  if (getAdapterMode() === "real" && !process.env.RESEND_API_KEY) {
    return { connected: false };
  }

  // Efeito externo primeiro: se o e-mail falhar, NÃO gravamos o dedupe e a
  // próxima rodada do cron tenta de novo.
  await emailProvider.send({
    to: owner.email,
    subject: "WhatsApp desconectado — reconexão necessária",
    html: [
      `<p>A sessão do WhatsApp (Z-API) está <strong>desconectada</strong>.</p>`,
      `<p>As mensagens continuam na fila e serão entregues assim que a sessão voltar — nada se perde, mas os clientes deixam de receber avisos até lá.</p>`,
      `<p><a href="${adminUrl}">Reconectar agora em ${adminUrl}</a> (escaneie o QR code com o celular da loja).</p>`,
    ].join("\n"),
    text: [
      "A sessão do WhatsApp (Z-API) está desconectada.",
      "As mensagens continuam na fila e serão entregues assim que a sessão voltar.",
      `Reconecte em: ${adminUrl} (escaneie o QR code com o celular da loja).`,
    ].join("\n"),
  });

  await db.insert(auditLog).values({
    actorType: "system",
    actorId: null,
    action: "wa.session_alert",
    entityType: "wa_session",
    entityId: "zapi",
    after: { connected: false, emailTo: owner.email },
  });

  return { connected: false };
}
