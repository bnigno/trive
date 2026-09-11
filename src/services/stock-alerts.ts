// "Me avisa quando voltar": um pedido de aviso por peça e telefone, com
// consentimento explícito; quando o disponível da peça sai de zero
// (stock.restocked), os avisos abertos viram UM evento cada, escalonados na
// janela de envio, e a cliente recebe UMA mensagem (foto da peça + texto).
// Quem deu SAIR não recebe; quem não tem estoque de novo espera o próximo.
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import type { MessagingProvider } from "@/adapters/zapi";
import { variantLabel } from "@/core/catalog/attributes";
import { renderTemplate } from "@/core/whatsapp/render";
import {
  DEFAULT_BULK_INTERVAL_SECONDS,
  DEFAULT_SEND_WINDOW,
  isWithinSendWindow,
  nextSendWindowStart,
  staggerSchedule,
  type SendWindow,
} from "@/core/whatsapp/send-window";
import {
  auditLog,
  customers,
  productImages,
  products,
  productVariants,
  stockAlerts,
  stockLevels,
  waTemplates,
} from "@/db/schema";
import { siteUrl } from "@/lib/site-url";
import { spDayKey } from "@/lib/sp-day";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";
import { getSettingsMap } from "@/services/settings";
import { publicImageUrl } from "@/services/store-catalog";
import {
  isWaEnabled,
  sendMediaMessage,
  sendTemplateMessage,
  type SendWaMessageResult,
} from "@/services/wa-messaging";

export const STOCK_BACK_TEMPLATE_KEY = "stock_back";

const E164 = /^\+[1-9]\d{7,14}$/;

export interface StockAlertView {
  id: string;
  variantId: string;
  sku: string;
  productName: string;
  productSlug: string;
  variantLabel: string;
  phoneE164: string;
  customerId: string | null;
  source: string;
  consentAt: Date;
  notifiedAt: Date | null;
  canceledAt: Date | null;
}

const alertSelect = {
  id: stockAlerts.id,
  variantId: stockAlerts.productVariantId,
  sku: productVariants.sku,
  productName: products.name,
  productSlug: products.slug,
  attributes: productVariants.attributes,
  attributesSchema: products.attributesSchema,
  phoneE164: stockAlerts.phoneE164,
  customerId: stockAlerts.customerId,
  source: stockAlerts.source,
  consentAt: stockAlerts.consentAt,
  notifiedAt: stockAlerts.notifiedAt,
  canceledAt: stockAlerts.canceledAt,
};

function alertsQuery(db: DbOrTx) {
  return db
    .select(alertSelect)
    .from(stockAlerts)
    .innerJoin(productVariants, eq(productVariants.id, stockAlerts.productVariantId))
    .innerJoin(products, eq(products.id, productVariants.productId));
}

function toView(row: {
  id: string;
  variantId: string;
  sku: string;
  productName: string;
  productSlug: string;
  attributes: unknown;
  attributesSchema: unknown;
  phoneE164: string;
  customerId: string | null;
  source: string;
  consentAt: Date;
  notifiedAt: Date | null;
  canceledAt: Date | null;
}): StockAlertView {
  const axes = Array.isArray(row.attributesSchema) ? (row.attributesSchema as string[]) : [];
  return {
    id: row.id,
    variantId: row.variantId,
    sku: row.sku,
    productName: row.productName,
    productSlug: row.productSlug,
    variantLabel: variantLabel((row.attributes ?? {}) as Record<string, string>, axes),
    phoneE164: row.phoneE164,
    customerId: row.customerId,
    source: row.source,
    consentAt: row.consentAt,
    notifiedAt: row.notifiedAt,
    canceledAt: row.canceledAt,
  };
}

const openCondition = and(isNull(stockAlerts.notifiedAt), isNull(stockAlerts.canceledAt));

// ---------------------------------------------------------------------------
// requestStockAlert / cancelStockAlert
// ---------------------------------------------------------------------------

const requestSchema = z.object({
  variantId: z.uuid(),
  phoneE164: z.string().regex(E164, "Telefone deve estar em E.164."),
  customerId: z.uuid().nullable().optional(),
  conversationId: z.uuid().nullable().optional(),
  source: z.enum(["lia", "site", "admin"]),
});

export type RequestStockAlertInput = z.input<typeof requestSchema>;

/** Idempotente: já existe aviso aberto para a peça e o telefone → created=false. */
export async function requestStockAlert(
  db: DbOrTx,
  input: RequestStockAlertInput,
): Promise<{ created: boolean; alertId: string | null }> {
  const parsed = requestSchema.parse(input);
  const [variant] = await db
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(and(eq(productVariants.id, parsed.variantId), isNull(productVariants.deletedAt)))
    .limit(1);
  if (!variant) throw new Error("Combinação não encontrada.");

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
    .insert(stockAlerts)
    .values({
      productVariantId: parsed.variantId,
      phoneE164: parsed.phoneE164,
      customerId,
      conversationId: parsed.conversationId ?? null,
      source: parsed.source,
    })
    .onConflictDoNothing()
    .returning({ id: stockAlerts.id });
  const alertId = inserted[0]?.id ?? null;
  if (alertId) {
    await db.insert(auditLog).values({
      actorType: parsed.source === "admin" ? "user" : parsed.source === "site" ? "customer" : "system",
      actorId: null,
      action: "stock.alert_request",
      entityType: "stock_alert",
      entityId: alertId,
      after: { variantId: parsed.variantId, phoneE164: parsed.phoneE164, source: parsed.source },
    });
  }
  return { created: alertId !== null, alertId };
}

export async function cancelStockAlert(
  db: DbOrTx,
  input: { alertId: string; userId?: string },
): Promise<{ canceled: boolean }> {
  const updated = await db
    .update(stockAlerts)
    .set({ canceledAt: new Date() })
    .where(and(eq(stockAlerts.id, input.alertId), openCondition))
    .returning({ id: stockAlerts.id });
  return { canceled: updated.length > 0 };
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

export async function listOpenAlertsByPhone(db: DbOrTx, phoneE164: string): Promise<StockAlertView[]> {
  const rows = await alertsQuery(db)
    .where(and(eq(stockAlerts.phoneE164, phoneE164), openCondition))
    .orderBy(asc(stockAlerts.consentAt));
  return rows.map(toView);
}

export async function listAlertsByCustomer(
  db: DbOrTx,
  input: { customerId?: string | null; phoneE164?: string | null; limit?: number },
): Promise<StockAlertView[]> {
  const conditions = [];
  if (input.customerId) conditions.push(eq(stockAlerts.customerId, input.customerId));
  if (input.phoneE164) conditions.push(eq(stockAlerts.phoneE164, input.phoneE164));
  if (conditions.length === 0) return [];
  const rows = await alertsQuery(db)
    .where(conditions.length === 1 ? conditions[0] : and(...conditions))
    .orderBy(asc(stockAlerts.consentAt))
    .limit(input.limit ?? 10);
  return rows.map(toView);
}

export async function listAlertsByVariant(db: DbOrTx, variantId: string, limit = 50): Promise<StockAlertView[]> {
  const rows = await alertsQuery(db)
    .where(eq(stockAlerts.productVariantId, variantId))
    .orderBy(asc(stockAlerts.consentAt))
    .limit(limit);
  return rows.map(toView);
}

// ---------------------------------------------------------------------------
// fanOutRestockAlerts — handler de stock.restocked
// ---------------------------------------------------------------------------

async function loadSendPolicy(db: DbOrTx): Promise<{ window: SendWindow; intervalSeconds: number }> {
  const map = await getSettingsMap(db, ["wa_send_window_start", "wa_send_window_end", "wa_bulk_interval_seconds"]);
  const start = Number(map["wa_send_window_start"]);
  const end = Number(map["wa_send_window_end"]);
  const interval = Number(map["wa_bulk_interval_seconds"]);
  return {
    window: {
      startHour: Number.isFinite(start) ? start : DEFAULT_SEND_WINDOW.startHour,
      endHour: Number.isFinite(end) ? end : DEFAULT_SEND_WINDOW.endHour,
    },
    intervalSeconds: Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_BULK_INTERVAL_SECONDS,
  };
}

/**
 * Um evento wa.restock_notify por aviso aberto, com next_attempt_at
 * escalonado a partir da abertura da janela — nunca uma rajada.
 */
export async function fanOutRestockAlerts(
  db: DbOrTx,
  input: { variantId: string; movementId: string; now?: Date },
): Promise<{ queued: number }> {
  const now = input.now ?? new Date();
  const open = await db
    .select({ id: stockAlerts.id })
    .from(stockAlerts)
    .where(and(eq(stockAlerts.productVariantId, input.variantId), openCondition))
    .orderBy(asc(stockAlerts.consentAt));
  if (open.length === 0) return { queued: 0 };

  const policy = await loadSendPolicy(db);
  const schedule = staggerSchedule(open.length, {
    from: nextSendWindowStart(now, policy.window),
    intervalSeconds: policy.intervalSeconds,
  });
  let queued = 0;
  for (const [index, alert] of open.entries()) {
    const id = await enqueueOutboxEvent(db, {
      eventType: "wa.restock_notify",
      dedupeKey: `wa.restock_notify:${alert.id}:${input.movementId}`,
      aggregateType: "stock_alert",
      aggregateId: alert.id,
      payload: { alertId: alert.id, variantId: input.variantId, movementId: input.movementId },
      nextAttemptAt: schedule[index],
    });
    if (id) queued += 1;
  }
  return { queued };
}

// ---------------------------------------------------------------------------
// notifyRestockAlert — handler de wa.restock_notify
// ---------------------------------------------------------------------------

export type NotifyRestockResult =
  | SendWaMessageResult
  | { skipped: "ja_avisado" | "sem_estoque" | "fora_da_janela" | "sem_template" | "inexistente" };

function firstName(fullName: string | null | undefined): string {
  return (fullName ?? "").trim().split(/\s+/)[0] ?? "";
}

export async function notifyRestockAlert(
  db: DbOrTx,
  provider: MessagingProvider,
  input: { alertId: string; movementId: string; now?: Date },
): Promise<NotifyRestockResult> {
  const now = input.now ?? new Date();
  const [row] = await alertsQuery(db).where(eq(stockAlerts.id, input.alertId)).limit(1);
  if (!row) return { skipped: "inexistente" };
  if (row.notifiedAt || row.canceledAt) return { skipped: "ja_avisado" };
  const alert = toView(row);

  if (!(await isWaEnabled(db))) return { skipped: "desabilitado" };

  const policy = await loadSendPolicy(db);
  if (!isWithinSendWindow(now, policy.window)) {
    // Adia para a abertura da janela (dedupe datado: no máximo um por dia).
    await enqueueOutboxEvent(db, {
      eventType: "wa.restock_notify",
      dedupeKey: `wa.restock_notify:${alert.id}:${input.movementId}:${spDayKey(now)}`,
      aggregateType: "stock_alert",
      aggregateId: alert.id,
      payload: { alertId: alert.id, variantId: alert.variantId, movementId: input.movementId },
      nextAttemptAt: nextSendWindowStart(now, policy.window),
    });
    return { skipped: "fora_da_janela" };
  }

  const [level] = await db
    .select({ onHand: stockLevels.onHand, reserved: stockLevels.reserved })
    .from(stockLevels)
    .where(eq(stockLevels.productVariantId, alert.variantId))
    .limit(1);
  const available = (level?.onHand ?? 0) - (level?.reserved ?? 0);
  if (available <= 0) return { skipped: "sem_estoque" };

  // Quem deu SAIR não recebe nem o aviso que pediu: cancela em silêncio.
  const [customer] = await db
    .select({ id: customers.id, fullName: customers.fullName, marketingOptIn: customers.marketingOptIn })
    .from(customers)
    .where(
      alert.customerId
        ? eq(customers.id, alert.customerId)
        : and(eq(customers.phoneE164, alert.phoneE164), isNull(customers.deletedAt)),
    )
    .limit(1);
  if (customer && !customer.marketingOptIn) {
    const [optOut] = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.action, "wa.opt_out"), eq(auditLog.entityId, customer.id)))
      .limit(1);
    if (optOut) {
      await cancelStockAlert(db, { alertId: alert.id });
      return { skipped: "sem_opt_in" };
    }
  }

  const [template] = await db
    .select({ bodyTemplate: waTemplates.bodyTemplate, isActive: waTemplates.isActive })
    .from(waTemplates)
    .where(eq(waTemplates.key, STOCK_BACK_TEMPLATE_KEY))
    .limit(1);
  if (!template || !template.isActive) return { skipped: "sem_template" };

  const vars = {
    nome: firstName(customer?.fullName),
    produto: `${alert.productName}${alert.variantLabel ? ` (${alert.variantLabel})` : ""}`,
    quantidade: String(available),
    link: `${siteUrl()}/produto/${alert.productSlug}`,
  };
  const dedupeKey = `wa.restock:${alert.id}`;

  const [image] = await db
    .select({ storagePath: productImages.storagePath })
    .from(productImages)
    .innerJoin(productVariants, eq(productVariants.productId, productImages.productId))
    .where(eq(productVariants.id, alert.variantId))
    .orderBy(asc(productImages.sortOrder), asc(productImages.createdAt))
    .limit(1);
  let imageUrl: string | null = null;
  if (image) {
    try {
      imageUrl = publicImageUrl(image.storagePath);
    } catch {
      imageUrl = null;
    }
  }

  const result: SendWaMessageResult = imageUrl
    ? await sendMediaMessage(db, provider, {
        kind: "image",
        imageUrl,
        body: renderTemplate(template.bodyTemplate, vars),
        phoneE164: alert.phoneE164,
        ...(customer ? { customerId: customer.id } : {}),
        dedupeKey,
        requireOptIn: false,
      })
    : await sendTemplateMessage(db, provider, {
        templateKey: STOCK_BACK_TEMPLATE_KEY,
        phoneE164: alert.phoneE164,
        vars,
        ...(customer ? { customerId: customer.id } : {}),
        dedupeKey,
        requireOptIn: false,
      });

  if ("sent" in result) {
    await db
      .update(stockAlerts)
      .set({ notifiedAt: now, notifiedWaMessageId: result.waMessageId })
      .where(eq(stockAlerts.id, alert.id));
  } else if (result.skipped === "ja_enviado") {
    await db
      .update(stockAlerts)
      .set({ notifiedAt: now })
      .where(and(eq(stockAlerts.id, alert.id), isNull(stockAlerts.notifiedAt)));
  }
  return result;
}
