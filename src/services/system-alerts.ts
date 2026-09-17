// Alertas de sistema para o dono: uma rotina (função do Inngest) que esgotou
// as tentativas e FALHOU não pode ficar só no painel do Inngest, que ninguém
// abre — o "Bom dia" falhou todo dia por semanas e a caixa de e-mail travou
// por dias sem que ninguém soubesse (16/09/2026). Avisa por WhatsApp (o
// número do dono) e por e-mail, no máximo uma vez por hora por rotina
// (dedupe no audit_log, 'system.function_failed_alert'). Nunca lança.
import { and, desc, eq, gt } from "drizzle-orm";

import { getEmailProvider, isEmailConfigured, type EmailProvider } from "@/adapters/email";
import type { MessagingProvider } from "@/adapters/zapi";
import { auditLog, users } from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { isWaEnabled, sendToOwner, siteBaseUrl } from "@/services/wa-messaging";

export const FUNCTION_FAILURE_ALERT_COOLDOWN_MS = 60 * 60_000;
const MESSAGE_MAX_CHARS = 300;

/** Nomes que o dono entende, por id da função no Inngest. */
const FUNCTION_LABELS: Record<string, string> = {
  "trive-outbox-sweep": "fila de envios (outbox)",
  "trive-outbox-kick": "fila de envios (kick)",
  "trive-daily-digest": "resumo diário (Bom dia)",
  "trive-email-poll": "leitura da caixa de e-mail",
  "trive-wa-session-monitor": "monitor da sessão do WhatsApp",
  "trive-wa-inbound-watchdog": "vigia do WhatsApp",
  "trive-wa-recovery": "recuperação de pedido não pago",
  "trive-wa-idle-cart-followup": "retomada de sacola parada",
  "trive-wa-auto-return": "volta automática das conversas",
  "trive-reservation-expiry": "expiração de reservas",
  "trive-hold-expiry": "expiração de reservas de estoque",
  "trive-drop-dispatch": "lançamentos programados",
  "trive-mp-reconciliation": "conciliação do Mercado Pago",
  "trive-delivery-positions-purge": "saídas do motoboy (limpeza)",
};

export type FunctionFailureAlertResult =
  | { skipped: "em_cooldown" | "sem_dono" | "proprio_alerta" }
  | { alerted: true; via: ("whatsapp" | "email")[] };

export async function alertFunctionFailure(
  db: DbOrTx,
  provider: MessagingProvider,
  input: { functionId: string; runId: string; message: string; now?: Date; emailProvider?: EmailProvider },
): Promise<FunctionFailureAlertResult> {
  // O alerta do alerta: se esta própria função falhar, parar aqui — senão
  // vira loop (inngest/function.failed → alerta → falha → …).
  if (input.functionId.endsWith("function-failure-alert")) return { skipped: "proprio_alerta" };
  const now = input.now ?? new Date();

  const [recent] = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "system.function_failed_alert"),
        eq(auditLog.entityId, input.functionId),
        gt(auditLog.createdAt, new Date(now.getTime() - FUNCTION_FAILURE_ALERT_COOLDOWN_MS)),
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  if (recent) return { skipped: "em_cooldown" };

  const label = FUNCTION_LABELS[input.functionId] ?? input.functionId;
  const message = input.message.replace(/\s+/g, " ").trim().slice(0, MESSAGE_MAX_CHARS);
  const body = `🚨 Rotina do sistema falhou: ${label}.\nErro: ${message}\nEla vai tentar de novo sozinha na próxima rodada; se este aviso se repetir, me chame. Detalhes: ${siteBaseUrl()}/admin/fila`;

  const via: ("whatsapp" | "email")[] = [];
  if (await isWaEnabled(db)) {
    try {
      const result = await sendToOwner(db, provider, { bodyOverride: body, dedupeKey: `system.function_failed:${input.functionId}:${input.runId}` });
      if ("sent" in result && result.sent) via.push("whatsapp");
    } catch (error) {
      console.warn("[system-alerts] aviso por WhatsApp falhou", error);
    }
  }
  if (isEmailConfigured()) {
    const [owner] = await db
      .select({ email: users.email })
      .from(users)
      .where(and(eq(users.role, "owner"), eq(users.isActive, true)))
      .limit(1);
    if (owner) {
      try {
        await (input.emailProvider ?? getEmailProvider()).send({
          to: owner.email,
          subject: `TRIVÉ: rotina "${label}" falhou`,
          text: body,
          html: `<pre style="font-family:inherit;white-space:pre-wrap">${body.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c)}</pre>`,
        });
        via.push("email");
      } catch (error) {
        console.warn("[system-alerts] aviso por e-mail falhou", error);
      }
    }
  }
  if (via.length === 0) return { skipped: "sem_dono" };

  await db.insert(auditLog).values({
    actorType: "system",
    actorId: null,
    action: "system.function_failed_alert",
    entityType: "inngest_function",
    entityId: input.functionId,
    after: { runId: input.runId, message, via },
    createdAt: now,
  });
  return { alerted: true, via };
}
