// Painel de conversas do WhatsApp (Fase 5, Onda C): leitura das conversas e
// ações do dono — assumir o atendimento, devolver ao bot e responder na mão.
// Resposta manual SEMPRE assume a conversa: com duas "vozes" ativas (dono e
// bot) o cliente receberia respostas conflitantes. O envio em si vai pela
// fila ('wa.send'), nunca inline — se a sessão Z-API cair, nada se perde.
import { and, asc, count, desc, eq, exists, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { randomUUID } from "node:crypto";

import {
  deriveWaMessageOrigin,
  type WaMessageOrigin,
  isProactiveBotReply,
  manualReplyDedupeKey,
  pendingInboundRows,
} from "@/core/whatsapp/origin";
import { parseBotState, type BotCartItem } from "@/core/bot/memory";
import {
  DEFAULT_HANDOFF_AUTO_RETURN_HOURS,
  hoursSetting,
  isIdleForHours,
  lastActivityAt,
} from "@/core/whatsapp/handoff";
import { auditLog, customers, orders, waConversations, waMessages, waFollowups } from "@/db/schema";
import { sameE164 } from "@/lib/phone";
import { enqueueOutboxEvent, type DbOrTx } from "@/queue/enqueue";
import { isBotEnabled } from "@/services/wa-bot";
import { getSettingsMap, ServiceError } from "@/services/settings";
import { listOpenAlertsByPhone } from "@/services/stock-alerts";
import { getActiveHoldByPhone } from "@/services/stock-holds";
import { FOLLOWUP_CANCEL_LABELS, listFollowupHistory, type FollowupCancelReason } from "@/services/wa-followups";
import { conversationIdsWithPendingSuggestion, getInboundPreview, getPendingSuggestion, loadStoreBotMode, resolveConversationBotMode, supersedePendingSuggestions } from "@/services/wa-suggestions";
import { resolveBotMode } from "@/core/bot/copilot";
import { getStyleProfileByPhone } from "@/services/style-profiles";
import { withSuggestionAnchors } from "@/services/wa-history";
import { originLabel } from "@/core/bot/site-bridge";

// "Não vista" = inbound criada depois da última leitura do dono; conversa
// nunca aberta (owner_last_seen_at NULL) conta tudo desde a época.
const unseenInboundFilter = and(
  eq(waMessages.direction, "inbound"),
  gt(
    waMessages.createdAt,
    sql`coalesce(${waConversations.ownerLastSeenAt}, 'epoch'::timestamptz)`,
  ),
);

// ---------------------------------------------------------------------------
// Leitura — lista e thread
// ---------------------------------------------------------------------------

export interface WaConversationListItem {
  id: string;
  phoneE164: string;
  customerName: string | null;
  /** Nome do perfil do WhatsApp (caderninho), quando não há cadastro. */
  displayName: string | null;
  status: string;
  botDisabledUntil: Date | null;
  lastMessageAt: Date | null;
  lastMessageDirection: "inbound" | "outbound" | null;
  /** Quem falou por último: cliente, vendedora, equipe ou automação. */
  lastMessageOrigin: WaMessageOrigin | null;
  lastMessagePreview: string | null;
  unreadCount: number;
  /**
   * A "conversa" com o próprio WhatsApp do dono: os avisos internos
   * (sendToOwner) criam uma conversa como qualquer outra. O painel a rotula
   * como avisos, em vez de mostrá-la como uma cliente.
   */
  isOwnerNotices: boolean;
  /** De onde a cliente veio (ponte do site): "página da peça", "story «Dunas»"…; null sem ponte. */
  originLabel: string | null;
  /** Copiloto: a Lia sugeriu e a dona ainda não decidiu. */
  pendingSuggestion: boolean;
  /** O modo efetivo desta conversa (loja + override). */
  botMode: "autonomous" | "copilot";
}

export async function listWaConversations(
  db: DbOrTx,
  options: { limit?: number } = {},
): Promise<WaConversationListItem[]> {
  const limit = options.limit ?? 100;

  const rows = await db
    .select({
      id: waConversations.id,
      phoneE164: waConversations.phoneE164,
      customerName: customers.fullName,
      status: waConversations.status,
      botMode: waConversations.botMode,
      botDisabledUntil: waConversations.botDisabledUntil,
      botState: waConversations.botState,
      updatedAt: waConversations.updatedAt,
    })
    .from(waConversations)
    .leftJoin(customers, eq(customers.id, waConversations.customerId))
    .orderBy(desc(waConversations.updatedAt))
    .limit(limit);

  if (rows.length === 0) return [];

  const settings = await getSettingsMap(db, ["owner_whatsapp_phone"]);
  const ownerPhone =
    typeof settings["owner_whatsapp_phone"] === "string"
      ? (settings["owner_whatsapp_phone"] as string).trim()
      : "";

  // Última mensagem de cada conversa em uma única consulta (DISTINCT ON).
  const ids = rows.map((row) => row.id);
  const lastMessages = await db
    .selectDistinctOn([waMessages.conversationId], {
      conversationId: waMessages.conversationId,
      direction: waMessages.direction,
      body: waMessages.body,
      dedupeKey: waMessages.dedupeKey,
      templateKey: waMessages.templateKey,
      createdAt: waMessages.createdAt,
    })
    .from(waMessages)
    .where(inArray(waMessages.conversationId, ids))
    .orderBy(waMessages.conversationId, desc(waMessages.createdAt));

  const byConversation = new Map(
    lastMessages.map((message) => [message.conversationId, message]),
  );

  // Não-lidas de todas as conversas da página em UMA query agregada
  // (nunca N+1): inbound criada depois da última leitura do dono.
  const unreadRows = await db
    .select({
      conversationId: waMessages.conversationId,
      unreadCount: count(),
    })
    .from(waMessages)
    .innerJoin(
      waConversations,
      eq(waConversations.id, waMessages.conversationId),
    )
    .where(and(inArray(waMessages.conversationId, ids), unseenInboundFilter))
    .groupBy(waMessages.conversationId);
  const unreadByConversation = new Map(
    unreadRows.map((row) => [row.conversationId, row.unreadCount]),
  );
  const [withSuggestion, storeMode] = await Promise.all([conversationIdsWithPendingSuggestion(db, ids), loadStoreBotMode(db)]);

  return rows.map((row) => {
    const last = byConversation.get(row.id) ?? null;
    const state = parseBotState(row.botState);
    return {
      id: row.id,
      phoneE164: row.phoneE164,
      customerName: row.customerName,
      displayName: state.displayName?.trim() || null,
      status: row.status,
      botDisabledUntil: row.botDisabledUntil,
      lastMessageAt: last?.createdAt ?? null,
      lastMessageDirection:
        last?.direction === "inbound" || last?.direction === "outbound"
          ? last.direction
          : null,
      lastMessageOrigin: last
        ? deriveWaMessageOrigin({
            direction: last.direction,
            dedupeKey: last.dedupeKey,
            templateKey: last.templateKey,
          })
        : null,
      lastMessagePreview: last?.body ?? null,
      unreadCount: unreadByConversation.get(row.id) ?? 0,
      isOwnerNotices: sameE164(ownerPhone, row.phoneE164),
      originLabel: state.bridge ? (state.bridge.sourceLabel ?? originLabel(state.bridge.source)) : null,
      pendingSuggestion: withSuggestion.has(row.id),
      botMode: resolveBotMode(storeMode, row.botMode),
    };
  });
}

export interface WaThreadMessage {
  id: string;
  direction: "inbound" | "outbound";
  /** Quem falou: cliente, robô, dono (manual) ou automação. */
  origin: WaMessageOrigin;
  /** A Lia chamou por conta (retorno combinado/retomada). */
  proactive: boolean;
  /** 'text' | 'image' (body é a legenda) | 'option_list' (body traz o menu). */
  kind: string;
  body: string;
  mediaUrl: string | null;
  templateKey: string | null;
  status: string;
  errorDetail: string | null;
  createdAt: Date;
}

export interface WaConversationThread {
  conversation: {
    id: string;
    phoneE164: string;
    customerId: string | null;
    customerName: string | null;
    status: string;
    botDisabledUntil: Date | null;
    createdAt: Date;
  };
  messages: WaThreadMessage[];
}

export async function getWaConversationThread(
  db: DbOrTx,
  conversationId: string,
): Promise<WaConversationThread | null> {
  const [conversation] = await db
    .select({
      id: waConversations.id,
      phoneE164: waConversations.phoneE164,
      customerId: waConversations.customerId,
      customerName: customers.fullName,
      status: waConversations.status,
      botDisabledUntil: waConversations.botDisabledUntil,
      createdAt: waConversations.createdAt,
    })
    .from(waConversations)
    .leftJoin(customers, eq(customers.id, waConversations.customerId))
    .where(eq(waConversations.id, conversationId))
    .limit(1);
  if (!conversation) return null;

  // Tie-break por id: mensagens do bot nascem na mesma transação com
  // created_at idêntico — sem ele a ordem oscilaria entre leituras.
  const rows = await db
    .select({
      id: waMessages.id,
      direction: waMessages.direction,
      kind: waMessages.kind,
      body: waMessages.body,
      mediaUrl: waMessages.mediaUrl,
      templateKey: waMessages.templateKey,
      dedupeKey: waMessages.dedupeKey,
      status: waMessages.status,
      errorDetail: waMessages.errorDetail,
      createdAt: waMessages.createdAt,
    })
    .from(waMessages)
    .where(eq(waMessages.conversationId, conversationId))
    .orderBy(asc(waMessages.createdAt), asc(waMessages.id));

  return {
    conversation,
    messages: rows.map((row) => ({
      id: row.id,
      direction: row.direction === "inbound" ? "inbound" : "outbound",
      origin: deriveWaMessageOrigin(row),
      proactive: isProactiveBotReply(row.dedupeKey),
      kind: row.kind,
      body: row.body,
      mediaUrl: row.mediaUrl,
      templateKey: row.templateKey,
      status: row.status,
      errorDetail: row.errorDetail,
      createdAt: row.createdAt,
    })),
  };
}

// ---------------------------------------------------------------------------
// Poll do chat — cauda da thread, "visto" e conversas aguardando o dono
// ---------------------------------------------------------------------------

export interface WaThreadTailMessage {
  id: string;
  direction: "inbound" | "outbound";
  origin: WaMessageOrigin;
  proactive: boolean;
  kind: string;
  body: string;
  mediaUrl: string | null;
  status: string;
  errorDetail: string | null;
  createdAt: Date;
}

/** O que o painel mostra ao lado da conversa: caderninho, sacola e pedidos. */
export interface WaConversationContext {
  /** Cartela de estilo (nome poético + resumo), reserva ativa e avisos pedidos. */
  style: string | null;
  hold: string | null;
  alerts: string[];
  /** Retornos combinados: o agendado (a Lia vai chamar) e os últimos encerrados, com o motivo. */
  followups: { id: string; kind: string; reason: string; dueAt: Date; status: string; note: string | null }[];
  customerId: string | null;
  customerName: string | null;
  displayName: string | null;
  notes: string[];
  cart: BotCartItem[];
  lastOrderNumber: number | null;
  handoff: { motivo: string; resumo: string | null; at: Date } | null;
  /** A ponte do site: de onde a cliente veio e o que estava vendendo. */
  bridge: { source: string; label: string; productLabel: string | null; at: Date } | null;
  recentOrders: {
    id: string;
    orderNumber: number;
    status: string;
    totalCents: number;
    createdAt: Date;
  }[];
}

/** O que a vendedora fez em cada turno (trilha 'wa.bot_turn' do audit). */
export interface WaBotTurnActivity {
  inboundId: string;
  tools: string[];
  handedOff: boolean;
  createdAt: Date;
}

export interface WaThreadSuggestion {
  id: string;
  bubbles: string[];
  /** O que vai antes do texto: a lista (título + opções) ou a foto (legenda + URL). */
  attachments: { kind: "lista" | "foto" | "audio"; title: string; lines: string[]; url: string | null }[];
  /** Só as ferramentas que rodaram de verdade (as bloqueadas ficam de fora). */
  toolCalls: string[];
  createdAt: Date;
  /** A mensagem dela que gerou a sugestão (null: retorno combinado). */
  inboundPreview: string | null;
  fromFollowup: boolean;
  /** customer (retorno combinado) | idle_cart (retomada da sacola) | null. */
  followupKind: string | null;
}

export interface WaThreadTail {
  conversation: {
    id: string;
    status: string;
    botDisabledUntil: Date | null;
    ownerLastSeenAt: Date | null;
    /** Override do modo nesta conversa (null = o da loja). */
    botMode: string | null;
    /** O modo efetivo (loja + override). */
    effectiveBotMode: "autonomous" | "copilot";
  };
  messages: WaThreadTailMessage[];
  context: WaConversationContext;
  activity: WaBotTurnActivity[];
  /** Copiloto: a sugestão pendente da Lia, se houver. */
  suggestion: WaThreadSuggestion | null;
}

async function loadConversationContext(
  db: DbOrTx,
  conversation: {
    id: string;
    phoneE164: string;
    customerId: string | null;
    customerName: string | null;
    botState: unknown;
  },
): Promise<WaConversationContext> {
  const state = parseBotState(conversation.botState);
  const recentOrders = conversation.customerId
    ? await db
        .select({
          id: orders.id,
          orderNumber: orders.orderNumber,
          status: orders.status,
          totalCents: orders.totalCents,
          createdAt: orders.createdAt,
        })
        .from(orders)
        .where(eq(orders.customerId, conversation.customerId))
        .orderBy(desc(orders.createdAt))
        .limit(3)
    : [];
  const [styleProfile, hold, alerts, followups] = await Promise.all([
    getStyleProfileByPhone(db, conversation.phoneE164),
    getActiveHoldByPhone(db, conversation.phoneE164),
    listOpenAlertsByPhone(db, conversation.phoneE164),
    listFollowupHistory(db, conversation.id, 4),
  ]);
  return {
    style: styleProfile
      ? `${styleProfile.paletteName}${
          Object.values(styleProfile.profile.sizes).filter(Boolean).length > 0
            ? ` · veste ${Object.entries(styleProfile.profile.sizes)
                .filter(([, v]) => v)
                .map(([k, v]) => `${k} ${v}`)
                .join(", ")}`
            : ""
        }${styleProfile.profile.colorsLove.length > 0 ? ` · ama ${styleProfile.profile.colorsLove.join(", ")}` : ""}${styleProfile.hasBodyMeasurements ? " · medidas guardadas" : ""}`
      : null,
    hold: hold?.description ?? null,
    alerts: alerts.map((alert) => `${alert.productName}${alert.variantLabel ? ` (${alert.variantLabel})` : ""}`),
    followups: followups.map((row) => ({
      id: row.id,
      kind: row.kind,
      reason: row.reason,
      dueAt: row.dueAt,
      status: row.status,
      note:
        row.status === "sent"
          ? row.suggestionStatus === "pending"
            ? "virou sugestão — aguardando você"
            : row.suggestionStatus === "discarded"
              ? "virou sugestão — você descartou"
              : row.suggestionStatus === "superseded"
                ? "virou sugestão — superada"
                : row.suggestionStatus === "sent"
                  ? "virou sugestão — você enviou"
                  : "chamou no horário"
          : row.canceledReason
            ? (FOLLOWUP_CANCEL_LABELS[row.canceledReason as FollowupCancelReason] ?? row.canceledReason)
            : null,
    })),
    customerId: conversation.customerId,
    customerName: conversation.customerName,
    displayName: state.displayName?.trim() || null,
    notes: state.notes ?? [],
    cart: state.cart ?? [],
    lastOrderNumber: state.lastOrderNumber ?? null,
    handoff: state.handoff
      ? {
          motivo: state.handoff.motivo,
          resumo: state.handoff.resumo ?? null,
          at: new Date(state.handoff.at),
        }
      : null,
    bridge: state.bridge
      ? {
          source: state.bridge.source,
          label: state.bridge.sourceLabel ?? originLabel(state.bridge.source),
          productLabel:
            state.bridge.items && state.bridge.items.length > 0 && state.bridge.source === "cart"
              ? state.bridge.items.map((item) => `${item.quantity}× ${item.name}${item.variation ? ` (${item.variation})` : ""}`).join(", ")
              : state.bridge.productName
                ? `${state.bridge.productName}${state.bridge.variation ? ` (${state.bridge.variation})` : ""}`
                : null,
          at: new Date(state.bridge.at),
        }
      : null,
    recentOrders,
  };
}

async function loadBotActivity(
  db: DbOrTx,
  conversationId: string,
  limit: number,
): Promise<WaBotTurnActivity[]> {
  const rows = await db
    .select({ after: auditLog.after, createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(
      and(eq(auditLog.action, "wa.bot_turn"), eq(auditLog.entityId, conversationId)),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);
  const activity: WaBotTurnActivity[] = [];
  for (const row of rows) {
    const after = (row.after ?? {}) as {
      inboundId?: unknown;
      toolCalls?: unknown;
      handedOff?: unknown;
    };
    if (typeof after.inboundId !== "string") continue;
    const tools = Array.isArray(after.toolCalls)
      ? after.toolCalls
          .map((call) =>
            typeof call === "object" && call !== null && "name" in call
              ? String((call as { name: unknown }).name)
              : null,
          )
          .filter((name): name is string => name !== null)
      : [];
    activity.push({
      inboundId: after.inboundId,
      tools,
      handedOff: after.handedOff === true,
      createdAt: row.createdAt,
    });
  }
  return activity.reverse();
}

const threadTailSchema = z.object({
  conversationId: z.uuid(),
  limit: z.number().int().min(1).max(100).default(30),
});

/**
 * Últimas N mensagens da conversa para o poll (sincronização por cauda: o
 * cliente faz upsert por id, então a mesma resposta cobre mensagem nova E
 * tick de status). Ordem estável mesmo com created_at empatado (tie-break
 * por id na MESMA direção do sort principal + reverse).
 */
export async function getWaThreadTail(
  db: DbOrTx,
  input: z.input<typeof threadTailSchema>,
): Promise<WaThreadTail | null> {
  const parsed = threadTailSchema.parse(input);

  const [conversation] = await db
    .select({
      id: waConversations.id,
      status: waConversations.status,
      botDisabledUntil: waConversations.botDisabledUntil,
      ownerLastSeenAt: waConversations.ownerLastSeenAt,
      botMode: waConversations.botMode,
      phoneE164: waConversations.phoneE164,
      customerId: waConversations.customerId,
      customerName: customers.fullName,
      botState: waConversations.botState,
    })
    .from(waConversations)
    .leftJoin(customers, eq(customers.id, waConversations.customerId))
    .where(eq(waConversations.id, parsed.conversationId))
    .limit(1);
  if (!conversation) return null;

  const rows = await db
    .select({
      id: waMessages.id,
      direction: waMessages.direction,
      kind: waMessages.kind,
      body: waMessages.body,
      mediaUrl: waMessages.mediaUrl,
      templateKey: waMessages.templateKey,
      dedupeKey: waMessages.dedupeKey,
      status: waMessages.status,
      errorDetail: waMessages.errorDetail,
      createdAt: waMessages.createdAt,
    })
    .from(waMessages)
    .where(eq(waMessages.conversationId, parsed.conversationId))
    .orderBy(desc(waMessages.createdAt), desc(waMessages.id))
    .limit(parsed.limit);
  rows.reverse();

  const [context, activity, pending, effectiveBotMode] = await Promise.all([
    loadConversationContext(db, conversation),
    loadBotActivity(db, conversation.id, parsed.limit),
    getPendingSuggestion(db, conversation.id),
    resolveConversationBotMode(db, conversation),
  ]);
  const suggestion: WaThreadSuggestion | null = pending
    ? {
        id: pending.id,
        bubbles: pending.bubbles,
        attachments: pending.attachments.map((attachment) =>
          attachment.kind === "option_list"
            ? { kind: "lista" as const, title: attachment.title, lines: [attachment.message, ...attachment.options.map((option) => `• ${option.title}`)], url: null }
            : attachment.kind === "audio"
              ? { kind: "audio" as const, title: "Áudio da curadora", lines: [attachment.body], url: attachment.audioUrl }
              : { kind: "foto" as const, title: "Foto", lines: [attachment.caption], url: attachment.imageUrl },
        ),
        toolCalls: pending.toolCalls.filter((call) => call.ok).map((call) => call.name),
        createdAt: pending.createdAt,
        inboundPreview: await getInboundPreview(db, pending.inboundMessageId),
        fromFollowup: pending.followupId !== null,
        followupKind: pending.followupId ? ((await db.select({ kind: waFollowups.kind }).from(waFollowups).where(eq(waFollowups.id, pending.followupId)).limit(1))[0]?.kind ?? null) : null,
      }
    : null;

  return {
    conversation: {
      id: conversation.id,
      status: conversation.status,
      botDisabledUntil: conversation.botDisabledUntil,
      ownerLastSeenAt: conversation.ownerLastSeenAt,
      botMode: conversation.botMode,
      effectiveBotMode,
    },
    messages: rows.map((row) => ({
      id: row.id,
      direction: row.direction === "inbound" ? "inbound" : "outbound",
      origin: deriveWaMessageOrigin(row),
      proactive: isProactiveBotReply(row.dedupeKey),
      kind: row.kind,
      body: row.body,
      mediaUrl: row.mediaUrl,
      status: row.status,
      errorDetail: row.errorDetail,
      createdAt: row.createdAt,
    })),
    context,
    activity,
    suggestion,
  };
}

const markSeenSchema = z.object({ conversationId: z.uuid() });

/**
 * Telemetria de leitura do painel: registra que o dono viu a thread agora.
 * NÃO bumpa updated_at (senão a lista reordenaria a cada leitura), NÃO
 * audita e aceita conversa fechada — ler não é uma ação de atendimento.
 */
export async function markConversationSeen(
  db: DbOrTx,
  input: z.input<typeof markSeenSchema>,
): Promise<{ seenAt: Date }> {
  const parsed = markSeenSchema.parse(input);
  const seenAt = new Date();

  const updated = await db
    .update(waConversations)
    .set({ ownerLastSeenAt: seenAt })
    .where(eq(waConversations.id, parsed.conversationId))
    .returning({ id: waConversations.id });
  if (updated.length === 0) {
    throw new ServiceError("conversa_inexistente", "Conversa não encontrada.");
  }
  return { seenAt };
}

function existsUnseenInbound(db: DbOrTx) {
  return exists(
    db
      .select({ one: sql`1` })
      .from(waMessages)
      .where(
        and(eq(waMessages.conversationId, waConversations.id), unseenInboundFilter),
      ),
  );
}

/**
 * Badge da sidebar: conversas transferidas para o dono ('human') que ainda
 * têm inbound não vista — apaga ao ler e reacende com mensagem nova.
 */
export async function countConversationsAwaitingOwner(
  db: DbOrTx,
): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(waConversations)
    .where(
      and(eq(waConversations.status, "human"), existsUnseenInbound(db)),
    );
  return row?.value ?? 0;
}

export interface WaAwaitingConversation {
  id: string;
  phoneE164: string;
  customerName: string | null;
}

/**
 * Versão com identidade (nome do cliente, se houver) das conversas que
 * aguardam o dono — alimenta o toast/notificação do poll light.
 */
export async function listConversationsAwaitingOwner(
  db: DbOrTx,
  options: { limit?: number } = {},
): Promise<WaAwaitingConversation[]> {
  const limit = options.limit ?? 10;
  return await db
    .select({
      id: waConversations.id,
      phoneE164: waConversations.phoneE164,
      customerName: customers.fullName,
    })
    .from(waConversations)
    .leftJoin(customers, eq(customers.id, waConversations.customerId))
    .where(
      and(eq(waConversations.status, "human"), existsUnseenInbound(db)),
    )
    .orderBy(desc(waConversations.updatedAt))
    .limit(limit);
}

// ---------------------------------------------------------------------------
// Ações do dono
// ---------------------------------------------------------------------------

async function loadConversationForAction(db: DbOrTx, conversationId: string) {
  const [conversation] = await db
    .select({
      id: waConversations.id,
      phoneE164: waConversations.phoneE164,
      customerId: waConversations.customerId,
      status: waConversations.status,
      botMode: waConversations.botMode,
    })
    .from(waConversations)
    .where(eq(waConversations.id, conversationId))
    .limit(1);
  if (!conversation) {
    throw new ServiceError("conversa_inexistente", "Conversa não encontrada.");
  }
  if (conversation.status === "closed") {
    throw new ServiceError(
      "conversa_fechada",
      "Esta conversa já foi encerrada.",
    );
  }
  return conversation;
}

const actorSchema = z.object({
  conversationId: z.uuid(),
  userId: z.uuid(),
});

/** Dono assume a conversa: o bot para de responder imediatamente. */
export async function takeOverWaConversation(
  db: DbOrTx,
  input: z.input<typeof actorSchema>,
): Promise<{ status: "human" }> {
  const parsed = actorSchema.parse(input);
  const conversation = await loadConversationForAction(
    db,
    parsed.conversationId,
  );
  if (conversation.status === "human") return { status: "human" };

  await db
    .update(waConversations)
    .set({ status: "human", updatedAt: new Date() })
    .where(eq(waConversations.id, conversation.id));
  await supersedePendingSuggestions(db, conversation.id);
  await db.insert(auditLog).values({
    actorType: "user",
    actorId: parsed.userId,
    action: "wa.conversation_takeover",
    entityType: "wa_conversation",
    entityId: conversation.id,
    before: { status: conversation.status },
    after: { status: "human" },
  });
  return { status: "human" };
}

/**
 * Dono devolve a conversa ao bot: reabre, limpa o silêncio pós-handoff e, se
 * a cliente escreveu depois da última saída (ficou esperando enquanto a
 * conversa estava com a equipe), enfileira o turno para a Lia responder
 * agora — não só quando ela escrever de novo.
 */
/** Quantas mensagens olhar para decidir se há algo dela sem resposta ao devolver à Lia. */
const RETURN_TO_BOT_LOOKBACK = 20;

export async function returnWaConversationToBot(
  db: DbOrTx,
  input: z.input<typeof actorSchema>,
): Promise<{ status: "open"; botTurnQueued: boolean }> {
  const parsed = actorSchema.parse(input);
  const conversation = await loadConversationForAction(
    db,
    parsed.conversationId,
  );

  await db
    .update(waConversations)
    .set({ status: "open", botDisabledUntil: null, updatedAt: new Date() })
    .where(eq(waConversations.id, conversation.id));
  await db.insert(auditLog).values({
    actorType: "user",
    actorId: parsed.userId,
    action: "wa.conversation_return_to_bot",
    entityType: "wa_conversation",
    entityId: conversation.id,
    before: { status: conversation.status },
    after: { status: "open", botDisabledUntil: null },
  });
  // O mesmo critério do turno: há mensagem dela sem resposta (da Lia ou da
  // equipe)? Aviso automático depois dela não conta como resposta.
  const recent = (
    await db
      .select({ id: waMessages.id, direction: waMessages.direction, body: waMessages.body, dedupeKey: waMessages.dedupeKey, templateKey: waMessages.templateKey, createdAt: waMessages.createdAt })
      .from(waMessages)
      .where(eq(waMessages.conversationId, conversation.id))
      .orderBy(desc(waMessages.createdAt), desc(waMessages.id))
      .limit(RETURN_TO_BOT_LOOKBACK)
  ).reverse();
  const lastMessage = pendingInboundRows(await withSuggestionAnchors(db, recent)).at(-1) ?? null;
  // SAIR/PARAR é comando (o aviso de saída responde a ele), não pergunta.
  const pending = lastMessage !== null && !isOptOutCommand(lastMessage.body ?? "");
  if (!pending || !(await isBotEnabled(db))) return { status: "open", botTurnQueued: false };
  const queued = await enqueueOutboxEvent(db, {
    eventType: "wa.bot_turn",
    dedupeKey: `wa.bot_turn:return:${lastMessage.id}`,
    aggregateType: "wa_conversation",
    aggregateId: conversation.id,
    payload: { conversationId: conversation.id },
  });
  return { status: "open", botTurnQueued: queued !== null };
}

function isOptOutCommand(text: string): boolean {
  const keyword = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toUpperCase();
  return keyword === "SAIR" || keyword === "PARAR";
}

/**
 * Conversas "com você" paradas (sem NENHUMA mensagem, sua ou dela) por
 * handoff_auto_return_hours voltam sozinhas para a vendedora — a cliente não
 * fica sem resposta porque a equipe não viu. 0 = nunca. Roda pelo cron
 * wa-auto-return; audita cada volta como ação do sistema.
 */
export async function autoReturnIdleHumanConversations(
  db: DbOrTx,
  opts: { now?: Date } = {},
): Promise<{ checked: number; returned: number; hours: number }> {
  const now = opts.now ?? new Date();
  const settings = await getSettingsMap(db, ["handoff_auto_return_hours"]);
  const hours = hoursSetting(settings["handoff_auto_return_hours"], DEFAULT_HANDOFF_AUTO_RETURN_HOURS, {
    min: 0,
  });
  if (hours <= 0) return { checked: 0, returned: 0, hours };

  const rows = await db
    .select({
      id: waConversations.id,
      lastInboundAt: waConversations.lastInboundAt,
      lastOutboundAt: waConversations.lastOutboundAt,
      updatedAt: waConversations.updatedAt,
      botDisabledUntil: waConversations.botDisabledUntil,
    })
    .from(waConversations)
    .where(eq(waConversations.status, "human"));

  let returned = 0;
  for (const row of rows) {
    const lastActivity = lastActivityAt(row);
    if (!isIdleForHours(lastActivity, now, hours)) continue;
    const updated = await db
      .update(waConversations)
      .set({ status: "open", botDisabledUntil: null, updatedAt: now })
      .where(and(eq(waConversations.id, row.id), eq(waConversations.status, "human")))
      .returning({ id: waConversations.id });
    if (updated.length === 0) continue;
    await db.insert(auditLog).values({
      actorType: "system",
      actorId: null,
      action: "wa.conversation_auto_return",
      entityType: "wa_conversation",
      entityId: row.id,
      before: { status: "human", botDisabledUntil: row.botDisabledUntil?.toISOString() ?? null },
      after: { status: "open", botDisabledUntil: null },
      reason: `sem mensagens há ${hours} h (última atividade ${lastActivity.toISOString()})`,
    });
    returned += 1;
  }
  return { checked: rows.length, returned, hours };
}

/**
 * Encerra a conversa: a vendedora e a equipe param de responder por aqui e a
 * próxima mensagem da cliente abre uma conversa nova (o caderninho vai junto,
 * ver wa-inbound). Audita quem encerrou.
 */
export async function closeWaConversation(
  db: DbOrTx,
  input: z.input<typeof actorSchema>,
): Promise<{ status: "closed" }> {
  const parsed = actorSchema.parse(input);
  const conversation = await loadConversationForAction(
    db,
    parsed.conversationId,
  );

  await db
    .update(waConversations)
    .set({ status: "closed", botDisabledUntil: null, updatedAt: new Date() })
    .where(eq(waConversations.id, conversation.id));
  await supersedePendingSuggestions(db, conversation.id);
  await db.insert(auditLog).values({
    actorType: "user",
    actorId: parsed.userId,
    action: "wa.conversation_close",
    entityType: "wa_conversation",
    entityId: conversation.id,
    before: { status: conversation.status },
    after: { status: "closed" },
  });
  return { status: "closed" };
}

const manualReplySchema = actorSchema.extend({
  body: z
    .string()
    .trim()
    .min(1, "Escreva a mensagem antes de enviar.")
    .max(4000, "A mensagem deve ter no máximo 4000 caracteres."),
  /** A última mensagem da cliente que estava na tela ao clicar Enviar: é a que esta resposta responde. */
  lastSeenInboundId: z.uuid().nullable().optional(),
});

/**
 * Resposta manual do dono. Assume a conversa (se ainda estava com o bot) e
 * enfileira o envio; o dedupe único por clique fica no evento da fila.
 */
export async function sendManualWaReply(
  db: DbOrTx,
  input: z.input<typeof manualReplySchema>,
): Promise<{ queued: true }> {
  const parsed = manualReplySchema.parse(input);
  const conversation = await loadConversationForAction(
    db,
    parsed.conversationId,
  );

  // Em copiloto responder é o normal — a conversa continua com a Lia
  // (sugerindo); a sugestão pendente perde o sentido: a dona já respondeu.
  if (conversation.status !== "human") {
    if ((await resolveConversationBotMode(db, conversation)) === "copilot") {
      await supersedePendingSuggestions(db, conversation.id);
    } else {
      await takeOverWaConversation(db, {
        conversationId: parsed.conversationId,
        userId: parsed.userId,
      });
    }
  }

  // A âncora só vale se for mesmo uma mensagem da cliente nesta conversa.
  let lastSeenInboundId: string | null = null;
  if (parsed.lastSeenInboundId) {
    const [seen] = await db
      .select({ id: waMessages.id })
      .from(waMessages)
      .where(and(eq(waMessages.id, parsed.lastSeenInboundId), eq(waMessages.conversationId, conversation.id), eq(waMessages.direction, "inbound")))
      .limit(1);
    lastSeenInboundId = seen?.id ?? null;
  }
  await enqueueOutboxEvent(db, {
    eventType: "wa.send",
    aggregateType: "wa_conversation",
    aggregateId: conversation.id,
    payload: {
      phoneE164: conversation.phoneE164,
      body: parsed.body,
      // O dedupe leva a mensagem dela que a dona estava respondendo (`:re:`);
      // a hora do clique vira o created_at da linha (a fila entrega depois).
      dedupeKey: manualReplyDedupeKey(randomUUID(), lastSeenInboundId),
      repliedAt: new Date().toISOString(),
      ...(conversation.customerId ? { customerId: conversation.customerId } : {}),
    },
  });
  return { queued: true };
}
