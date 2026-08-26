// Serviço de mensageria WhatsApp (Fase 4): TODO envio passa por aqui, sempre
// chamado pelos handlers do outbox (nunca inline no request). Idempotência
// forte via dedupe_key UNIQUE em wa_messages; falha REAL do provedor LANÇA
// (retry/backoff/DLQ da fila reentregam) e a retentativa RETOMA a mensagem
// failed em vez de duplicar. Opt-in LGPD (customers.marketing_opt_in) é
// obrigatório para mensagens ao CLIENTE (requireOptIn: true); avisos internos
// ao DONO não precisam.
import { and, eq, gt, isNull, lt, ne } from "drizzle-orm";
import { z } from "zod";

import { getAdapterMode } from "@/adapters/adapter-mode";
import type { MessagingProvider } from "@/adapters/zapi";
import { PAYMENT_METHOD_LABELS_SHORT } from "@/core/orders/payment-methods";
import { renderTemplate } from "@/core/whatsapp/render";
import {
  auditLog,
  customers,
  orders,
  waConversations,
  waMessages,
  waTemplates,
} from "@/db/schema";
import { formatDateTimeSP } from "@/emails/templates";
import { formatCentsBRL } from "@/lib/money";
import { isValidE164 } from "@/lib/phone";
import type { DbOrTx } from "@/queue/enqueue";
import { getSettingsMap, ServiceError } from "@/services/settings";

export { ServiceError };

const E164_SCHEMA = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/, "Telefone deve estar em E.164 (ex.: +5511999998888).");

// ---------------------------------------------------------------------------
// isWaEnabled — espelha isMpEnabled (store-payments): o toggle sozinho não
// basta; em modo real também exige as credenciais da Z-API no ambiente.
// ---------------------------------------------------------------------------

export async function isWaEnabled(db: DbOrTx): Promise<boolean> {
  const map = await getSettingsMap(db, ["wa_enabled"]);
  if (map["wa_enabled"] !== true) return false;
  if (getAdapterMode() === "fake") return true;
  const instanceId = process.env.ZAPI_INSTANCE_ID;
  const instanceToken = process.env.ZAPI_INSTANCE_TOKEN;
  return (
    typeof instanceId === "string" &&
    instanceId.trim() !== "" &&
    typeof instanceToken === "string" &&
    instanceToken.trim() !== ""
  );
}

// ---------------------------------------------------------------------------
// Helpers de variáveis de pedido (puros — reutilizados pelo handler do outbox
// e pela recuperação de pedido não pago).
// ---------------------------------------------------------------------------

const DEFAULT_SITE_URL = "https://trive-lime.vercel.app";

export function siteBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL?.trim() || DEFAULT_SITE_URL).replace(
    /\/+$/,
    "",
  );
}

export function orderPublicUrl(publicToken: string): string {
  return `${siteBaseUrl()}/pedido/${publicToken}`;
}

export function firstNameOf(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? fullName;
}

/**
 * Variáveis padrão dos templates de pedido ({{nome}}, {{cliente}}, {{pedido}},
 * {{total}}, {{link}}, {{prazo}}, {{rastreio}}, {{loja}}). Chave ausente no
 * template simplesmente não é usada — e chave usada sem valor vira '' no
 * render (nunca lança em produção).
 */
// Labels curtos da fonte única do core (WhatsApp pede mensagens compactas).
const PAYMENT_METHOD_LABELS: Record<string, string> = PAYMENT_METHOD_LABELS_SHORT;

export function buildOrderVars(input: {
  orderNumber: number;
  customerName: string;
  totalCents: number;
  publicToken: string;
  paymentDueAt: Date | null;
  trackingCode?: string | null;
  storeName?: string;
  paymentMethod?: string | null;
}): Record<string, string> {
  return {
    nome: firstNameOf(input.customerName),
    cliente: input.customerName,
    pedido: String(input.orderNumber),
    total: formatCentsBRL(input.totalCents),
    link: orderPublicUrl(input.publicToken),
    prazo: input.paymentDueAt ? formatDateTimeSP(input.paymentDueAt) : "",
    rastreio: input.trackingCode ?? "",
    loja: input.storeName ?? "TRIVË",
    metodo: input.paymentMethod
      ? (PAYMENT_METHOD_LABELS[input.paymentMethod] ?? input.paymentMethod)
      : "",
  };
}

// ---------------------------------------------------------------------------
// sendTemplateMessage
// ---------------------------------------------------------------------------

const sendTemplateMessageSchema = z
  .object({
    templateKey: z.string().min(1).optional(),
    /** Corpo avulso (sem template) — ex.: resposta manual do dono. */
    bodyOverride: z.string().min(1).optional(),
    phoneE164: E164_SCHEMA,
    vars: z.record(z.string(), z.string()).default({}),
    customerId: z.uuid().optional(),
    orderId: z.uuid().optional(),
    dedupeKey: z.string().min(1).optional(),
    requireOptIn: z.boolean(),
  })
  .refine((value) => (value.templateKey != null) !== (value.bodyOverride != null), {
    message: "Informe templateKey OU bodyOverride (exatamente um).",
  });

export type SendTemplateMessageInput = z.input<typeof sendTemplateMessageSchema>;

export type WaSkipReason =
  | "desabilitado"
  | "sem_opt_in"
  | "sem_template"
  | "ja_enviado"
  | "sem_telefone_dono"
  | "numero_sem_whatsapp";

export type SendWaMessageResult =
  | { sent: true; waMessageId: string }
  | { skipped: WaSkipReason };

/**
 * Garante a conversa aberta (não-closed) do telefone — no máximo UMA por
 * número (unique parcial). Vincula o cliente à conversa quando conhecido.
 */
async function upsertConversation(
  db: DbOrTx,
  phoneE164: string,
  customerId: string | null,
): Promise<string> {
  const [existing] = await db
    .select({ id: waConversations.id, customerId: waConversations.customerId })
    .from(waConversations)
    .where(
      and(
        eq(waConversations.phoneE164, phoneE164),
        ne(waConversations.status, "closed"),
      ),
    )
    .limit(1);
  if (existing) {
    if (customerId && !existing.customerId) {
      await db
        .update(waConversations)
        .set({ customerId, updatedAt: new Date() })
        .where(eq(waConversations.id, existing.id));
    }
    return existing.id;
  }

  const inserted = await db
    .insert(waConversations)
    .values({ phoneE164, customerId })
    .onConflictDoNothing()
    .returning({ id: waConversations.id });
  if (inserted[0]) return inserted[0].id;

  // Corrida rara: outro processo criou a conversa entre o select e o insert.
  const [raced] = await db
    .select({ id: waConversations.id })
    .from(waConversations)
    .where(
      and(
        eq(waConversations.phoneE164, phoneE164),
        ne(waConversations.status, "closed"),
      ),
    )
    .limit(1);
  if (!raced) {
    throw new ServiceError(
      "conversa_indisponivel",
      `Não foi possível garantir a conversa do telefone ${phoneE164}.`,
    );
  }
  return raced.id;
}

/**
 * Resolve o cliente (por id, senão pelo telefone) — necessário para o opt-in
 * e para vincular a conversa.
 */
async function resolveCustomer(
  db: DbOrTx,
  customerId: string | undefined,
  phoneE164: string,
): Promise<{ id: string; marketingOptIn: boolean } | null> {
  if (customerId) {
    const [row] = await db
      .select({ id: customers.id, marketingOptIn: customers.marketingOptIn })
      .from(customers)
      .where(eq(customers.id, customerId))
      .limit(1);
    return row ?? null;
  }
  const [row] = await db
    .select({ id: customers.id, marketingOptIn: customers.marketingOptIn })
    .from(customers)
    .where(
      and(eq(customers.phoneE164, phoneE164), isNull(customers.deletedAt)),
    )
    .limit(1);
  return row ?? null;
}

type OutboundMessageInsert = typeof waMessages.$inferInsert;

/**
 * Insere a linha outbound respeitando dedupe_key UNIQUE:
 * - linha existente sent/delivered/read → { skipped: 'ja_enviado' };
 * - failed (provedor falhou) ou queued (tentativa interrompida antes do envio)
 *   → RETOMA: volta a queued aplicando resumePatch, na MESMA linha, nunca uma
 *   segunda mensagem.
 */
async function insertOrResumeOutboundMessage(
  db: DbOrTx,
  values: OutboundMessageInsert,
  resumePatch: Partial<OutboundMessageInsert>,
): Promise<{ waMessageId: string } | { skipped: "ja_enviado" }> {
  const dedupeKey = values.dedupeKey ?? null;
  if (!dedupeKey) {
    const [inserted] = await db
      .insert(waMessages)
      .values(values)
      .returning({ id: waMessages.id });
    return { waMessageId: inserted.id };
  }

  const inserted = await db
    .insert(waMessages)
    .values(values)
    .onConflictDoNothing({ target: waMessages.dedupeKey })
    .returning({ id: waMessages.id });
  if (inserted[0]) return { waMessageId: inserted[0].id };

  const [existing] = await db
    .select({ id: waMessages.id, status: waMessages.status })
    .from(waMessages)
    .where(eq(waMessages.dedupeKey, dedupeKey))
    .limit(1);
  if (!existing) {
    throw new ServiceError(
      "dedupe_inconsistente",
      `Conflito de dedupe sem linha correspondente (${dedupeKey}).`,
    );
  }
  if (existing.status !== "failed" && existing.status !== "queued") {
    return { skipped: "ja_enviado" };
  }
  await db
    .update(waMessages)
    .set({ status: "queued", errorDetail: null, ...resumePatch })
    .where(eq(waMessages.id, existing.id));
  return { waMessageId: existing.id };
}

/**
 * A Z-API aceita envio para número SEM WhatsApp em silêncio (caso real do
 * pedido #1000): o serviço consulta antes. Falha PERMANENTE — a linha fica
 * visível como 'failed' no admin e o evento da fila conclui sem retry (skip).
 */
async function failNumberWithoutWhatsapp(
  db: DbOrTx,
  waMessageId: string,
  phoneE164: string,
): Promise<{ skipped: "numero_sem_whatsapp" }> {
  await db
    .update(waMessages)
    .set({
      status: "failed",
      errorDetail: "Número sem WhatsApp — confira o telefone do cliente.",
    })
    .where(eq(waMessages.id, waMessageId));
  await db.insert(auditLog).values({
    actorType: "system",
    actorId: null,
    action: "wa.send_failed",
    entityType: "wa_message",
    entityId: waMessageId,
    after: { phoneE164, reason: "numero_sem_whatsapp" },
  });
  return { skipped: "numero_sem_whatsapp" };
}

/**
 * Executa o envio no provedor e fecha o ciclo da linha: sucesso → sent +
 * lastOutboundAt da conversa + audit; falha REAL → failed + error_detail e
 * RELANÇA (retry/backoff/DLQ da fila reentregam e caem na retomada do dedupe).
 */
async function deliverOutboundMessage(
  db: DbOrTx,
  input: {
    waMessageId: string;
    conversationId: string;
    send: () => Promise<{ providerMessageId: string }>;
    auditAfter: Record<string, unknown>;
  },
): Promise<{ sent: true; waMessageId: string }> {
  try {
    const { providerMessageId } = await input.send();
    const now = new Date();
    await db
      .update(waMessages)
      .set({
        status: "sent",
        zapiMessageId: providerMessageId,
        sentAt: now,
        errorDetail: null,
      })
      .where(eq(waMessages.id, input.waMessageId));
    await db
      .update(waConversations)
      .set({ lastOutboundAt: now, updatedAt: now })
      .where(eq(waConversations.id, input.conversationId));
    await db.insert(auditLog).values({
      actorType: "system",
      actorId: null,
      action: "notification.whatsapp",
      entityType: "wa_message",
      entityId: input.waMessageId,
      after: input.auditAfter,
    });
    return { sent: true, waMessageId: input.waMessageId };
  } catch (error) {
    await db
      .update(waMessages)
      .set({
        status: "failed",
        errorDetail: error instanceof Error ? error.message : String(error),
      })
      .where(eq(waMessages.id, input.waMessageId));
    throw error;
  }
}

/**
 * Envia uma mensagem (template ativo OU bodyOverride) para phoneE164, com:
 * - toggle wa_enabled (+ credenciais em modo real) → { skipped: 'desabilitado' };
 * - opt-in LGPD quando requireOptIn (sem cliente ou sem opt-in → 'sem_opt_in',
 *   e NADA é gravado);
 * - idempotência: dedupeKey UNIQUE em wa_messages — repetição vira
 *   { skipped: 'ja_enviado' }; linha failed/queued é RETOMADA
 *   (→ queued → tenta de novo) em vez de pular;
 * - falha do provedor: marca a linha como failed + error_detail e RELANÇA
 *   (o retry da fila reprocessa e cai na retomada acima).
 */
export async function sendTemplateMessage(
  db: DbOrTx,
  provider: MessagingProvider,
  input: SendTemplateMessageInput,
): Promise<SendWaMessageResult> {
  const parsed = sendTemplateMessageSchema.parse(input);

  if (!(await isWaEnabled(db))) return { skipped: "desabilitado" };

  const customer = await resolveCustomer(db, parsed.customerId, parsed.phoneE164);

  if (parsed.requireOptIn && (!customer || !customer.marketingOptIn)) {
    return { skipped: "sem_opt_in" };
  }

  let body: string;
  if (parsed.templateKey != null) {
    const [template] = await db
      .select({
        bodyTemplate: waTemplates.bodyTemplate,
        isActive: waTemplates.isActive,
      })
      .from(waTemplates)
      .where(eq(waTemplates.key, parsed.templateKey))
      .limit(1);
    if (!template || !template.isActive) return { skipped: "sem_template" };
    body = renderTemplate(template.bodyTemplate, parsed.vars);
  } else {
    // bodyOverride garantido pelo refine do schema.
    body = renderTemplate(parsed.bodyOverride as string, parsed.vars);
  }

  const conversationId = await upsertConversation(
    db,
    parsed.phoneE164,
    customer?.id ?? null,
  );

  const insertResult = await insertOrResumeOutboundMessage(
    db,
    {
      conversationId,
      direction: "outbound",
      body,
      templateKey: parsed.templateKey ?? null,
      dedupeKey: parsed.dedupeKey ?? null,
      status: "queued",
      orderId: parsed.orderId ?? null,
    },
    { body },
  );
  if ("skipped" in insertResult) return insertResult;
  const { waMessageId } = insertResult;

  if (!(await provider.phoneExists(parsed.phoneE164))) {
    return failNumberWithoutWhatsapp(db, waMessageId, parsed.phoneE164);
  }

  return deliverOutboundMessage(db, {
    waMessageId,
    conversationId,
    send: () => provider.sendText({ toE164: parsed.phoneE164, body }),
    auditAfter: {
      to: parsed.phoneE164,
      templateKey: parsed.templateKey ?? null,
      orderId: parsed.orderId ?? null,
    },
  });
}

// ---------------------------------------------------------------------------
// sendMediaMessage — imagem (URL pública) e lista interativa de opções.
// ---------------------------------------------------------------------------

const sendMediaMessageCommonFields = {
  phoneE164: E164_SCHEMA,
  /** Legenda (image) ou mensagem convidativa CRUA do menu (option_list). */
  body: z.string().min(1),
  customerId: z.uuid().optional(),
  orderId: z.uuid().optional(),
  dedupeKey: z.string().min(1),
  requireOptIn: z.boolean().default(false),
};

const sendMediaMessageSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("image"),
    imageUrl: z.url(),
    ...sendMediaMessageCommonFields,
  }),
  z.object({
    kind: z.literal("option_list"),
    optionList: z.object({
      title: z.string().min(1),
      buttonLabel: z.string().min(1),
      options: z
        .array(
          z.object({
            id: z.string().min(1).max(64),
            title: z.string().min(1).max(24),
            description: z.string().optional(),
          }),
        )
        .min(1)
        .max(10),
    }),
    ...sendMediaMessageCommonFields,
  }),
]);

export type SendMediaMessageInput = z.input<typeof sendMediaMessageSchema>;

/**
 * Envia mensagem de MÍDIA (imagem ou lista de opções) com as MESMAS regras de
 * sendTemplateMessage (wa_enabled, opt-in quando requireOptIn, phoneExists,
 * dedupe com retomada, falha do provedor relança).
 *
 * body persistido em wa_messages é o que o histórico do bot e a thread do
 * admin leem: a legenda (image) ou o menu já renderizado com as opções em
 * linhas '• título — descrição' (option_list). Ao provedor vai a mensagem
 * CRUA + opções estruturadas.
 */
export async function sendMediaMessage(
  db: DbOrTx,
  provider: MessagingProvider,
  input: SendMediaMessageInput,
): Promise<SendWaMessageResult> {
  const parsed = sendMediaMessageSchema.parse(input);

  if (!(await isWaEnabled(db))) return { skipped: "desabilitado" };

  const customer = await resolveCustomer(db, parsed.customerId, parsed.phoneE164);

  if (parsed.requireOptIn && (!customer || !customer.marketingOptIn)) {
    return { skipped: "sem_opt_in" };
  }

  const persistedBody =
    parsed.kind === "option_list"
      ? [
          parsed.body,
          ...parsed.optionList.options.map((option) =>
            option.description
              ? `• ${option.title} — ${option.description}`
              : `• ${option.title}`,
          ),
        ].join("\n")
      : parsed.body;
  const mediaUrl = parsed.kind === "image" ? parsed.imageUrl : null;

  const conversationId = await upsertConversation(
    db,
    parsed.phoneE164,
    customer?.id ?? null,
  );

  const insertResult = await insertOrResumeOutboundMessage(
    db,
    {
      conversationId,
      direction: "outbound",
      kind: parsed.kind,
      body: persistedBody,
      mediaUrl,
      dedupeKey: parsed.dedupeKey,
      status: "queued",
      orderId: parsed.orderId ?? null,
    },
    { kind: parsed.kind, body: persistedBody, mediaUrl },
  );
  if ("skipped" in insertResult) return insertResult;
  const { waMessageId } = insertResult;

  if (!(await provider.phoneExists(parsed.phoneE164))) {
    return failNumberWithoutWhatsapp(db, waMessageId, parsed.phoneE164);
  }

  return deliverOutboundMessage(db, {
    waMessageId,
    conversationId,
    send: () =>
      parsed.kind === "image"
        ? provider.sendImage({
            toE164: parsed.phoneE164,
            imageUrl: parsed.imageUrl,
            caption: parsed.body,
          })
        : provider.sendOptionList({
            toE164: parsed.phoneE164,
            message: parsed.body,
            title: parsed.optionList.title,
            buttonLabel: parsed.optionList.buttonLabel,
            options: parsed.optionList.options,
          }),
    auditAfter: {
      to: parsed.phoneE164,
      kind: parsed.kind,
      orderId: parsed.orderId ?? null,
    },
  });
}

// ---------------------------------------------------------------------------
// sendToOwner — avisos internos ao dono (sem opt-in, sem cliente/pedido).
// ---------------------------------------------------------------------------

const sendToOwnerSchema = z
  .object({
    templateKey: z.string().min(1).optional(),
    bodyOverride: z.string().min(1).optional(),
    vars: z.record(z.string(), z.string()).default({}),
    dedupeKey: z.string().min(1).optional(),
  })
  .refine((value) => (value.templateKey != null) !== (value.bodyOverride != null), {
    message: "Informe templateKey OU bodyOverride (exatamente um).",
  });

export type SendToOwnerInput = z.input<typeof sendToOwnerSchema>;

export async function sendToOwner(
  db: DbOrTx,
  provider: MessagingProvider,
  input: SendToOwnerInput,
): Promise<SendWaMessageResult> {
  const parsed = sendToOwnerSchema.parse(input);

  const map = await getSettingsMap(db, ["owner_whatsapp_phone"]);
  const phone = map["owner_whatsapp_phone"];
  if (typeof phone !== "string" || !isValidE164(phone)) {
    return { skipped: "sem_telefone_dono" };
  }

  return sendTemplateMessage(db, provider, {
    templateKey: parsed.templateKey,
    bodyOverride: parsed.bodyOverride,
    vars: parsed.vars,
    dedupeKey: parsed.dedupeKey,
    phoneE164: phone,
    requireOptIn: false,
  });
}

// ---------------------------------------------------------------------------
// recoverUnpaidOrders — recuperação de pedido não pago (cron */15).
// UMA única mensagem por pedido, para sempre: o dedupe 'wa.recovery:<orderId>'
// (UNIQUE em wa_messages) garante que nem re-execuções do cron nem retries
// gerem uma segunda cobrança.
// ---------------------------------------------------------------------------

export interface RecoverUnpaidOrdersResult {
  checked: number;
  sent: number;
  skipped: number;
  failed: number;
}

const DEFAULT_RECOVERY_AFTER_MINUTES = 60;

export async function recoverUnpaidOrders(
  db: DbOrTx,
  provider: MessagingProvider,
): Promise<RecoverUnpaidOrdersResult> {
  const counters: RecoverUnpaidOrdersResult = {
    checked: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
  };
  if (!(await isWaEnabled(db))) return counters;

  const map = await getSettingsMap(db, ["wa_recovery_after_minutes", "store_name"]);
  const rawMinutes = map["wa_recovery_after_minutes"];
  const afterMinutes =
    typeof rawMinutes === "number" && Number.isFinite(rawMinutes) && rawMinutes > 0
      ? rawMinutes
      : DEFAULT_RECOVERY_AFTER_MINUTES;
  const storeName =
    typeof map["store_name"] === "string" && (map["store_name"] as string).trim() !== ""
      ? (map["store_name"] as string).trim()
      : undefined;

  const now = new Date();
  const createdBefore = new Date(now.getTime() - afterMinutes * 60_000);

  // Pedidos da loja parados em pending_payment há mais de N minutos, cuja
  // reserva AINDA está válida (payment_due_at no futuro) — depois disso a
  // reserva expira e cobrar seria pior que inútil.
  const rows = await db
    .select({
      orderId: orders.id,
      orderNumber: orders.orderNumber,
      publicToken: orders.publicToken,
      paymentDueAt: orders.paymentDueAt,
      totalCents: orders.totalCents,
      customerId: customers.id,
      customerName: customers.fullName,
      phoneE164: customers.phoneE164,
    })
    .from(orders)
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(
      and(
        eq(orders.status, "pending_payment"),
        eq(orders.channel, "store"),
        lt(orders.createdAt, createdBefore),
        gt(orders.paymentDueAt, now),
      ),
    );

  for (const row of rows) {
    counters.checked += 1;
    if (!row.phoneE164) {
      counters.skipped += 1;
      continue;
    }
    try {
      const result = await sendTemplateMessage(db, provider, {
        templateKey: "order_recovery",
        phoneE164: row.phoneE164,
        vars: buildOrderVars({
          orderNumber: row.orderNumber,
          customerName: row.customerName,
          totalCents: row.totalCents,
          publicToken: row.publicToken,
          paymentDueAt: row.paymentDueAt,
          storeName,
        }),
        customerId: row.customerId,
        orderId: row.orderId,
        dedupeKey: `wa.recovery:${row.orderId}`,
        requireOptIn: true,
      });
      if ("sent" in result) {
        counters.sent += 1;
        await db.insert(auditLog).values({
          actorType: "system",
          actorId: null,
          action: "wa.recovery",
          entityType: "order",
          entityId: row.orderId,
          after: { waMessageId: result.waMessageId, to: row.phoneE164 },
        });
      } else {
        counters.skipped += 1;
      }
    } catch (error) {
      // Cron: falha num pedido não pode abortar os demais; a linha ficou
      // 'failed' e a próxima rodada retoma via dedupe (failed → queued).
      console.warn(
        `[wa-recovery] Falha ao enviar recuperação do pedido ${row.orderId}:`,
        error,
      );
      counters.failed += 1;
    }
  }

  return counters;
}
