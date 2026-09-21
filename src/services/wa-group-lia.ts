// A Lia e o Provador: o que o grupo devolve vira conversa no PRIVADO, e no
// grupo ela só fala quando chamada.
//
// - Menção (@Lia no grupo): um turno curto, só com o catálogo, respondido no
//   grupo citando a mensagem — 5 por hora por sala, uma por menção.
// - Sinais no caderninho: voto, reação e menção viram linhas para a conversa
//   1:1 (core/groups/mention.ts).
// - Avisos no privado, todos com opt-in, na janela e com dedupe: afinidade
//   depois do "Passou pelo Provador" (a peça no tamanho e na cor dela),
//   "ficou a última no seu tamanho" para quem reagiu (1 por semana), e a
//   vencedora da enquete que chegou (para quem votou nela).
// - "só privado" / SAIR: sai do grupo pela fila (wa.group_remove).
//
// Intervalo entre avisos ativos: 5 min (boas práticas da Z-API), nunca os
// 20 s do lote de "voltou".

import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { SalesAssistant } from "@/adapters/assistant";
import type { MessagingProvider } from "@/adapters/zapi";
import { parseBotState } from "@/core/bot/memory";
import { DEFAULT_SELLER_NAME } from "@/core/bot/prompt";
import { typingSecondsFor } from "@/core/bot/reply";
import { renderStoreMap } from "@/core/bot/store-map";
import type { BotToolName } from "@/core/bot/tools";
import { type AudienceCandidate, type DropAffinityProduct, rankAudience, scoreProductAffinity } from "@/core/drops";
import { sizeKeyForCategory } from "@/core/style/profile";
import { canPublishNow, nextPublishableAt } from "@/core/groups/cadence";
import { clampMentionReply, lastUnitNoticeAllowed, mentionReplyAllowed } from "@/core/groups/health";
import { renderMentionReplyBody, renderMentionUserMessage } from "@/core/groups/mention";
import { buildGroupMentionPrompt } from "@/core/groups/mention-prompt";
import { decodePollVote } from "@/core/groups/signals";
import { staggerWithinWindow } from "@/core/whatsapp/send-window";
import {
  auditLog,
  customers,
  outboxEvents,
  productVariants,
  products,
  stockLevels,
  waGroupMembers,
  waGroupPosts,
  waGroups,
  waGroupSignals,
} from "@/db/schema";
import { isWaLid } from "@/lib/phone";
import { spDayKey } from "@/lib/sp-day";
import { type DbOrTx, enqueueOutboxEvent } from "@/queue/enqueue";
import { loadAudienceCandidates } from "@/services/drops";
import { getSettingsMap } from "@/services/settings";
import { getStoreMap } from "@/services/store-catalog";
import { buildToolExecutor, isBotEnabled } from "@/services/wa-bot";
import { loadGroupPolicy } from "@/services/wa-groups";
import { isWaEnabled, sendTemplateMessage, siteBaseUrl } from "@/services/wa-messaging";

import { DEFAULT_BOT_MODEL, DEFAULT_STORE_NAME } from "./bot/shared";

export const GROUP_MENTION_EVENT = "wa.group_mention";
export const GROUP_REMOVE_EVENT = "wa.group_remove";
export const GROUP_AFFINITY_FANOUT_EVENT = "wa.group_affinity_fanout";
export const GROUP_AFFINITY_NOTICE_EVENT = "wa.group_affinity_notice";
export const GROUP_LAST_UNIT_NOTICE_EVENT = "wa.group_last_unit_notice";
export const GROUP_POLL_WINNER_NOTICE_EVENT = "wa.group_poll_winner_notice";

/** No grupo a Lia só lê o catálogo: nada de sacola, reserva, cadastro ou transferência. */
export const GROUP_MENTION_TOOLS: readonly BotToolName[] = ["listar_produtos", "detalhar_produto"];

/** Entre dois avisos ativos do Provador no privado (Z-API recomenda ≥ 5 min). */
export const GROUP_NOTICE_INTERVAL_SECONDS = 300;

/** Reações a posts mais velhos que isto não contam para "ficou a última". */
const REACTION_LOOKBACK_DAYS = 30;

export const groupMentionPayloadSchema = z.object({ signalId: z.uuid() });
export const groupRemovePayloadSchema = z.object({ phoneE164: z.string().min(1), reason: z.enum(["so_privado", "saiu"]) });
export const groupAffinityFanoutPayloadSchema = z.object({ postId: z.uuid() });
export const groupAffinityNoticePayloadSchema = z.object({ postId: z.uuid(), customerId: z.uuid() });
export const groupLastUnitPayloadSchema = z.object({ variantId: z.uuid(), movementId: z.string().min(1) });
export const groupLastUnitNoticePayloadSchema = z.object({ variantId: z.uuid(), customerId: z.uuid(), postId: z.uuid() });
export const groupPollWinnerNoticePayloadSchema = z.object({ postId: z.uuid(), variantId: z.uuid(), customerId: z.uuid() });

// ---------------------------------------------------------------------------
// Menção: enfileirar (do webhook) e responder (da fila)
// ---------------------------------------------------------------------------

export type EnqueueMentionResult = "queued" | "duplicado" | "desligado" | "teto_hora";

/**
 * Chamada no grupo → um turno na fila, se a Lia pode falar no grupo e a
 * sala ainda tem orçamento nesta hora. Dedupe por sinal: o replay do webhook
 * não enfileira duas vezes.
 */
export async function maybeEnqueueMentionTurn(db: DbOrTx, input: { signalId: string; groupId: string; now?: Date }): Promise<EnqueueMentionResult> {
  const policy = await loadGroupPolicy(db);
  if (!policy.groupsEnabled || !policy.mentionsEnabled) return "desligado";
  // O relógio é o do banco (created_at do outbox): a hora é a da fila, não a de quem chamou.
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.eventType, GROUP_MENTION_EVENT),
        eq(outboxEvents.aggregateType, "wa_group"),
        eq(outboxEvents.aggregateId, input.groupId),
        sql`${outboxEvents.createdAt} >= now() - interval '1 hour'`,
      ),
    );
  if (!mentionReplyAllowed({ repliesLastHour: Number(count) })) return "teto_hora";
  const id = await enqueueOutboxEvent(
    db,
    {
      eventType: GROUP_MENTION_EVENT,
      dedupeKey: `${GROUP_MENTION_EVENT}:${input.signalId}`,
      aggregateType: "wa_group",
      aggregateId: input.groupId,
      payload: { signalId: input.signalId },
    },
    { kick: false },
  );
  return id ? "queued" : "duplicado";
}

export type MentionTurnResult =
  | { replied: true; providerMessageId: string; reply: string }
  | { skipped: "inexistente" | "nao_e_mencao" | "desligado" | "bot_desligado" | "whatsapp_desligado" | "sala_inativa" | "ja_respondida" | "sem_resposta" };

/**
 * O turno da Lia no grupo: prompt público, só catálogo, duas linhas, citando
 * a mensagem dela. Idempotente pelo audit (wa.group_mention_reply): o retry
 * da fila não responde duas vezes. Falha do modelo LANÇA (a fila tenta de
 * novo pela política do evento).
 */
export async function runGroupMentionTurn(
  db: DbOrTx,
  assistant: SalesAssistant,
  provider: MessagingProvider,
  input: { signalId: string; now?: Date; deadlineAt?: Date | null },
): Promise<MentionTurnResult> {
  const now = input.now ?? new Date();
  const [row] = await db
    .select({ signal: waGroupSignals, group: waGroups })
    .from(waGroupSignals)
    .innerJoin(waGroups, eq(waGroups.id, waGroupSignals.groupId))
    .where(eq(waGroupSignals.id, input.signalId))
    .limit(1);
  if (!row) return { skipped: "inexistente" };
  const { signal, group } = row;
  if (signal.kind !== "mention") return { skipped: "nao_e_mencao" };
  if (!group.isActive) return { skipped: "sala_inativa" };
  const policy = await loadGroupPolicy(db);
  if (!policy.groupsEnabled || !policy.mentionsEnabled) return { skipped: "desligado" };
  if (!(await isWaEnabled(db))) return { skipped: "whatsapp_desligado" };
  if (!(await isBotEnabled(db))) return { skipped: "bot_desligado" };
  const [already] = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.action, "wa.group_mention_reply"), eq(auditLog.entityId, signal.id)))
    .limit(1);
  if (already) return { skipped: "ja_respondida" };

  const map = await getSettingsMap(db, ["store_name", "bot_model", "bot_seller_name"]);
  const text = (key: string): string => (typeof map[key] === "string" ? (map[key] as string).trim() : "");
  const storeName = text("store_name") || DEFAULT_STORE_NAME;
  const model = text("bot_model") || DEFAULT_BOT_MODEL;
  const sellerName = text("bot_seller_name") || DEFAULT_SELLER_NAME;
  const storeMap = renderStoreMap(await getStoreMap(db));
  const system = buildGroupMentionPrompt({ storeName, sellerName, groupName: group.name, siteUrl: siteBaseUrl(), ...(storeMap ? { storeMap } : {}) });

  const [customer] = signal.customerId
    ? await db.select({ fullName: customers.fullName }).from(customers).where(eq(customers.id, signal.customerId)).limit(1)
    : [];
  const senderName = customer?.fullName?.trim().split(/\s+/)[0] ?? null;
  const history = [{ role: "user" as const, text: renderMentionUserMessage({ groupName: group.name, senderName, text: signal.value }) }];

  // Executor sem anexos (nenhuma lista/foto sai no grupo) e sem gravar nada:
  // o caderninho de overlay nasce vazio e morre com o turno.
  const executeTool = buildToolExecutor(db, {
    conversationId: group.id,
    phoneE164: signal.participantPhone,
    customerId: signal.customerId,
    lastInboundId: signal.id,
    dryRun: true,
    stateOverlay: { current: parseBotState(null) },
    now,
    proactive: true,
  });
  const turn = await assistant.respondTurn({
    system,
    history,
    model,
    executeTool,
    tools: GROUP_MENTION_TOOLS,
    ...(input.deadlineAt ? { deadlineAt: input.deadlineAt } : {}),
  });
  const reply = clampMentionReply(turn.reply ?? "");
  if (reply === "") return { skipped: "sem_resposta" };

  const digits = isWaLid(signal.participantPhone) ? null : signal.participantPhone.replace(/\D/g, "");
  const body = renderMentionReplyBody({ reply, participantPhoneDigits: digits });
  const { providerMessageId } = await provider.sendText({
    toE164: group.providerGroupId,
    body,
    quotedProviderMessageId: signal.providerMessageId,
    ...(digits ? { mentionedPhones: [digits] } : {}),
    typingSeconds: typingSecondsFor(reply, "first"),
  });
  await db.insert(auditLog).values({
    actorType: "system",
    actorId: null,
    action: "wa.group_mention_reply",
    entityType: "wa_group_signal",
    entityId: signal.id,
    after: { groupId: group.id, providerMessageId, reply, model, toolCalls: turn.toolCalls, usage: turn.usage },
  });
  return { replied: true, providerMessageId, reply };
}

// ---------------------------------------------------------------------------
// "só privado" e SAIR: fora do grupo, pela fila
// ---------------------------------------------------------------------------

/**
 * Marca a saída nas salas em que ela está e enfileira a remoção (efeito
 * externo só pela fila). Devolve quantas salas; zero = não estava em nenhuma.
 */
export async function leaveGroupsByPhone(db: DbOrTx, input: { phoneE164: string; reason: "so_privado" | "saiu"; now?: Date }): Promise<{ groups: number }> {
  const now = input.now ?? new Date();
  const rows = await db
    .update(waGroupMembers)
    .set({ leftAt: now, leftReason: input.reason, updatedAt: now })
    .where(and(eq(waGroupMembers.phoneE164, input.phoneE164), isNull(waGroupMembers.leftAt)))
    .returning({ groupId: waGroupMembers.groupId });
  if (rows.length === 0) return { groups: 0 };
  await enqueueOutboxEvent(
    db,
    {
      eventType: GROUP_REMOVE_EVENT,
      dedupeKey: `${GROUP_REMOVE_EVENT}:${input.phoneE164}:${now.getTime()}`,
      aggregateType: "wa_group_member",
      payload: { phoneE164: input.phoneE164, reason: input.reason },
    },
    { kick: false },
  );
  return { groups: rows.length };
}

/** Handler de wa.group_remove: tira a pessoa de todas as salas ativas (o WhatsApp da loja precisa ser admin). */
export async function removeFromGroups(db: DbOrTx, provider: MessagingProvider, input: { phoneE164: string }): Promise<{ removed: number }> {
  const rows = await db
    .select({ providerGroupId: waGroups.providerGroupId })
    .from(waGroupMembers)
    .innerJoin(waGroups, eq(waGroups.id, waGroupMembers.groupId))
    .where(and(eq(waGroupMembers.phoneE164, input.phoneE164), eq(waGroups.isActive, true)));
  let removed = 0;
  for (const row of rows) {
    await provider.removeGroupParticipants(row.providerGroupId, [input.phoneE164]);
    removed += 1;
  }
  return { removed };
}

// ---------------------------------------------------------------------------
// Afinidade: depois do "Passou pelo Provador", a peça no tamanho e na cor dela
// ---------------------------------------------------------------------------

async function loadAffinityProductsByIds(db: DbOrTx, productIds: readonly string[]): Promise<DropAffinityProduct[]> {
  if (productIds.length === 0) return [];
  const rows = await db
    .select({
      id: products.id,
      name: products.name,
      categoryId: products.categoryId,
      categoryName: sql<string | null>`(select c.name from categories c where c.id = ${products.categoryId})`,
      color: sql<string | null>`${productVariants.attributes} ->> 'cor'`,
      size: sql<string | null>`${productVariants.attributes} ->> 'tamanho'`,
      available: sql<string>`coalesce(${stockLevels.onHand}, 0) - coalesce(${stockLevels.reserved}, 0)`,
    })
    .from(products)
    .leftJoin(productVariants, and(eq(productVariants.productId, products.id), isNull(productVariants.deletedAt), eq(productVariants.isActive, true)))
    .leftJoin(stockLevels, eq(stockLevels.productVariantId, productVariants.id))
    .where(and(inArray(products.id, [...productIds]), isNull(products.deletedAt)));
  const map = new Map<string, DropAffinityProduct & { sizes: Set<string>; colors: Set<string> }>();
  for (const row of rows) {
    const entry =
      map.get(row.id) ??
      map.set(row.id, { id: row.id, name: row.name, categoryId: row.categoryId, categoryName: row.categoryName, sizesAvailable: [], colorsAvailable: [], sizes: new Set(), colors: new Set() }).get(row.id)!;
    if (Number(row.available) > 0) {
      if (row.size) entry.sizes.add(row.size);
      if (row.color) entry.colors.add(row.color);
    }
  }
  return [...map.values()].map(({ sizes, colors, ...rest }) => ({ ...rest, sizesAvailable: [...sizes], colorsAvailable: [...colors] }));
}

/** Membras ativas da sala que têm cadastro com opt-in (as candidatas a aviso). */
async function groupCandidates(db: DbOrTx, groupId: string): Promise<AudienceCandidate[]> {
  const members = await db
    .select({ phoneE164: waGroupMembers.phoneE164, customerId: waGroupMembers.customerId })
    .from(waGroupMembers)
    .where(and(eq(waGroupMembers.groupId, groupId), isNull(waGroupMembers.leftAt)));
  if (members.length === 0) return [];
  const phones = new Set(members.map((m) => m.phoneE164));
  const ids = new Set(members.map((m) => m.customerId).filter((id): id is string => id !== null));
  const all = await loadAudienceCandidates(db);
  return all.filter((candidate) => ids.has(candidate.customerId) || phones.has(candidate.phoneE164));
}

/**
 * Handler de wa.group_affinity_fanout: quem pontua ≥ 2 numa peça do post
 * recebe UM aviso no privado, escalonado de 5 em 5 min na janela, até o
 * teto de convidadas (drop_audience_limit). Um aviso por pessoa por post.
 */
export async function fanOutAffinityNotices(db: DbOrTx, input: { postId: string; now?: Date }): Promise<{ queued: number; candidates: number }> {
  const now = input.now ?? new Date();
  const [post] = await db.select().from(waGroupPosts).where(eq(waGroupPosts.id, input.postId)).limit(1);
  if (!post || post.status !== "sent" || !post.productIds || post.productIds.length === 0) return { queued: 0, candidates: 0 };
  const policy = await loadGroupPolicy(db);
  if (!policy.groupsEnabled) return { queued: 0, candidates: 0 };
  const [affinityProducts, candidates, settings] = await Promise.all([
    loadAffinityProductsByIds(db, post.productIds),
    groupCandidates(db, post.groupId),
    getSettingsMap(db, ["drop_audience_limit"]),
  ]);
  const limitRaw = Number(settings["drop_audience_limit"]);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 60;
  const ranked = rankAudience(candidates, affinityProducts, limit);
  if (ranked.length === 0) return { queued: 0, candidates: candidates.length };
  const schedule = staggerWithinWindow(ranked.length, { from: now, intervalSeconds: GROUP_NOTICE_INTERVAL_SECONDS, window: policy.cadence.window });
  let queued = 0;
  for (const [index, invite] of ranked.entries()) {
    const id = await enqueueOutboxEvent(db, {
      eventType: GROUP_AFFINITY_NOTICE_EVENT,
      dedupeKey: `${GROUP_AFFINITY_NOTICE_EVENT}:${post.id}:${invite.customerId}`,
      aggregateType: "wa_group_post",
      aggregateId: post.id,
      payload: { postId: post.id, customerId: invite.customerId },
      nextAttemptAt: schedule[index],
    });
    if (id) queued += 1;
  }
  return { queued, candidates: candidates.length };
}

type NoticeSkip = "inexistente" | "provador_desligado" | "sem_afinidade" | "fora_da_janela" | "sem_template" | "sem_opt_in" | "desabilitado" | "sem_telefone_dono" | "numero_inexistente" | "ja_enviado";
export type GroupNoticeResult = { sent: true } | { skipped: NoticeSkip | string };

function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? "";
}

/** Adia um aviso do privado para o próximo instante publicável (janela e sem domingo), uma vez por dia. */
async function deferNotice(db: DbOrTx, input: { eventType: string; dedupeBase: string; aggregateType: string; aggregateId: string; payload: Record<string, unknown>; now: Date }): Promise<void> {
  const policy = await loadGroupPolicy(db);
  await enqueueOutboxEvent(db, {
    eventType: input.eventType,
    dedupeKey: `${input.dedupeBase}:${spDayKey(input.now)}`,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    payload: input.payload,
    nextAttemptAt: nextPublishableAt(input.now, policy.cadence),
  });
}

/** Handler de wa.group_affinity_notice: a peça do post no tamanho e na cor dela, com o motivo real. */
export async function sendAffinityNotice(db: DbOrTx, provider: MessagingProvider, input: { postId: string; customerId: string; now?: Date }): Promise<GroupNoticeResult> {
  const now = input.now ?? new Date();
  const [post] = await db.select().from(waGroupPosts).where(eq(waGroupPosts.id, input.postId)).limit(1);
  if (!post || !post.productIds) return { skipped: "inexistente" };
  const policy = await loadGroupPolicy(db);
  if (!policy.groupsEnabled) return { skipped: "provador_desligado" };
  const [candidate] = (await groupCandidates(db, post.groupId)).filter((c) => c.customerId === input.customerId);
  if (!candidate) return { skipped: "sem_opt_in" };
  if (!canPublishNow(now, policy.cadence)) {
    await deferNotice(db, { eventType: GROUP_AFFINITY_NOTICE_EVENT, dedupeBase: `${GROUP_AFFINITY_NOTICE_EVENT}:${post.id}:${input.customerId}`, aggregateType: "wa_group_post", aggregateId: post.id, payload: { postId: post.id, customerId: input.customerId }, now });
    return { skipped: "fora_da_janela" };
  }
  // A melhor peça do post para ela, de novo na hora de mandar (o estoque mudou desde o post).
  const affinityProducts = await loadAffinityProductsByIds(db, post.productIds);
  let best: { product: DropAffinityProduct; score: number; reasons: string[] } | null = null;
  for (const product of affinityProducts) {
    const result = scoreProductAffinity(candidate, product);
    if (result.score >= 2 && (best === null || result.score > best.score)) best = { product, ...result };
  }
  if (!best) return { skipped: "sem_afinidade" };
  const sizeKey = sizeKeyForCategory(best.product.categoryName, best.product.name);
  const size = sizeKey ? (candidate.profile?.sizes[sizeKey] ?? "") : "";
  return sendTemplateMessage(db, provider, {
    templateKey: "provador_affinity",
    phoneE164: candidate.phoneE164,
    customerId: candidate.customerId,
    vars: {
      nome: firstName(candidate.fullName),
      peca: best.product.name,
      tamanho: size,
      motivo: best.reasons.join(" e "),
      horas: String(policy.holdHours),
    },
    dedupeKey: `${GROUP_AFFINITY_NOTICE_EVENT}:${post.id}:${input.customerId}`,
    requireOptIn: true,
  });
}

// ---------------------------------------------------------------------------
// "Ficou a última no seu tamanho": para quem reagiu ao post da peça
// ---------------------------------------------------------------------------

/**
 * Handler de stock.last_unit: quem reagiu (❤️ ou qualquer emoji) a um post
 * com esta peça nos últimos 30 dias, tem cadastro com opt-in e veste o
 * tamanho da unidade que sobrou recebe UM aviso — no máximo um por semana
 * por pessoa (audit wa.group_last_unit).
 */
export async function fanOutLastUnitNotices(db: DbOrTx, input: { variantId: string; movementId: string; now?: Date }): Promise<{ queued: number }> {
  const now = input.now ?? new Date();
  const policy = await loadGroupPolicy(db);
  if (!policy.groupsEnabled) return { queued: 0 };
  const [variant] = await db
    .select({ productId: productVariants.productId, size: sql<string | null>`${productVariants.attributes} ->> 'tamanho'` })
    .from(productVariants)
    .where(eq(productVariants.id, input.variantId))
    .limit(1);
  if (!variant) return { queued: 0 };
  const since = new Date(now.getTime() - REACTION_LOOKBACK_DAYS * 86_400_000);
  const reactions = await db
    .select({ postId: waGroupPosts.id, groupId: waGroupPosts.groupId, participant: waGroupSignals.participantPhone, customerId: waGroupSignals.customerId })
    .from(waGroupSignals)
    .innerJoin(waGroupPosts, eq(waGroupPosts.id, waGroupSignals.postId))
    .where(
      and(
        eq(waGroupSignals.kind, "reaction"),
        sql`${waGroupSignals.value} <> ''`,
        gte(waGroupSignals.createdAt, since),
        sql`${waGroupPosts.productIds} @> ${JSON.stringify([variant.productId])}::jsonb`,
      ),
    );
  if (reactions.length === 0) return { queued: 0 };
  const byGroup = new Map<string, typeof reactions>();
  for (const row of reactions) (byGroup.get(row.groupId) ?? byGroup.set(row.groupId, []).get(row.groupId))!.push(row);
  const targets: { postId: string; customerId: string }[] = [];
  const seen = new Set<string>();
  const [product] = await db
    .select({ name: products.name, categoryName: sql<string | null>`(select c.name from categories c where c.id = ${products.categoryId})` })
    .from(products)
    .where(eq(products.id, variant.productId))
    .limit(1);
  const sizeKey = product ? sizeKeyForCategory(product.categoryName, product.name) : null;
  for (const [groupId, rows] of byGroup) {
    const candidates = await groupCandidates(db, groupId);
    for (const row of rows) {
      const candidate = candidates.find((c) => c.customerId === row.customerId || c.phoneE164 === row.participant);
      if (!candidate || seen.has(candidate.customerId)) continue;
      const wanted = sizeKey ? candidate.profile?.sizes[sizeKey] : undefined;
      if (!variant.size || !wanted || wanted.trim().toLowerCase() !== variant.size.trim().toLowerCase()) continue;
      seen.add(candidate.customerId);
      targets.push({ postId: row.postId, customerId: candidate.customerId });
    }
  }
  if (targets.length === 0) return { queued: 0 };
  const schedule = staggerWithinWindow(targets.length, { from: now, intervalSeconds: GROUP_NOTICE_INTERVAL_SECONDS, window: policy.cadence.window });
  let queued = 0;
  for (const [index, target] of targets.entries()) {
    const id = await enqueueOutboxEvent(db, {
      eventType: GROUP_LAST_UNIT_NOTICE_EVENT,
      dedupeKey: `${GROUP_LAST_UNIT_NOTICE_EVENT}:${input.variantId}:${target.customerId}:${input.movementId}`,
      aggregateType: "product_variant",
      aggregateId: input.variantId,
      payload: { variantId: input.variantId, customerId: target.customerId, postId: target.postId },
      nextAttemptAt: schedule[index],
    });
    if (id) queued += 1;
  }
  return { queued };
}

/** Handler de wa.group_last_unit_notice. */
export async function sendLastUnitNotice(db: DbOrTx, provider: MessagingProvider, input: { variantId: string; customerId: string; postId: string; now?: Date }): Promise<GroupNoticeResult> {
  const now = input.now ?? new Date();
  const policy = await loadGroupPolicy(db);
  if (!policy.groupsEnabled) return { skipped: "provador_desligado" };
  const [variant] = await db
    .select({ name: products.name, size: sql<string | null>`${productVariants.attributes} ->> 'tamanho'`, onHand: stockLevels.onHand, reserved: stockLevels.reserved })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(stockLevels, eq(stockLevels.productVariantId, productVariants.id))
    .where(eq(productVariants.id, input.variantId))
    .limit(1);
  if (!variant) return { skipped: "inexistente" };
  // Ainda é a última? (vendeu ou repôs desde o evento: o aviso mentiria.)
  if ((variant.onHand ?? 0) - (variant.reserved ?? 0) !== 1) return { skipped: "nao_e_mais_a_ultima" };
  const [customer] = await db.select({ id: customers.id, fullName: customers.fullName, phoneE164: customers.phoneE164 }).from(customers).where(eq(customers.id, input.customerId)).limit(1);
  if (!customer?.phoneE164) return { skipped: "inexistente" };
  const [last] = await db
    .select({ createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(and(eq(auditLog.action, "wa.group_last_unit"), eq(auditLog.entityId, customer.id)))
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  if (!lastUnitNoticeAllowed({ lastNoticeAt: last?.createdAt ?? null, now })) return { skipped: "uma_por_semana" };
  if (!canPublishNow(now, policy.cadence)) {
    await deferNotice(db, { eventType: GROUP_LAST_UNIT_NOTICE_EVENT, dedupeBase: `${GROUP_LAST_UNIT_NOTICE_EVENT}:${input.variantId}:${input.customerId}`, aggregateType: "product_variant", aggregateId: input.variantId, payload: { ...input, now: undefined }, now });
    return { skipped: "fora_da_janela" };
  }
  const result = await sendTemplateMessage(db, provider, {
    templateKey: "provador_last_unit",
    phoneE164: customer.phoneE164,
    customerId: customer.id,
    vars: { nome: firstName(customer.fullName), peca: variant.name, tamanho: variant.size ?? "único" },
    dedupeKey: `${GROUP_LAST_UNIT_NOTICE_EVENT}:${input.variantId}:${input.customerId}`,
    requireOptIn: true,
  });
  if ("sent" in result) {
    await db.insert(auditLog).values({
      actorType: "system",
      actorId: null,
      action: "wa.group_last_unit",
      entityType: "customer",
      entityId: customer.id,
      after: { variantId: input.variantId, postId: input.postId },
    });
    return { sent: true };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Vencedora da enquete chegou: para quem votou nela
// ---------------------------------------------------------------------------

function fold(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
}

/**
 * Handler complementar de stock.restocked: enquetes apuradas nos últimos 60
 * dias cuja peça é a desta variação e cuja vencedora é a cor (ou o
 * tamanho) que chegou → quem votou nela recebe o aviso, escalonado.
 */
export async function fanOutPollWinnerNotices(db: DbOrTx, input: { variantId: string; movementId: string; now?: Date }): Promise<{ queued: number }> {
  const now = input.now ?? new Date();
  const policy = await loadGroupPolicy(db);
  if (!policy.groupsEnabled) return { queued: 0 };
  const [variant] = await db
    .select({ productId: productVariants.productId, color: sql<string | null>`${productVariants.attributes} ->> 'cor'`, size: sql<string | null>`${productVariants.attributes} ->> 'tamanho'` })
    .from(productVariants)
    .where(eq(productVariants.id, input.variantId))
    .limit(1);
  if (!variant) return { queued: 0 };
  const since = new Date(now.getTime() - 60 * 86_400_000);
  const polls = await db
    .select({ id: waGroupPosts.id, groupId: waGroupPosts.groupId, providerMessageId: waGroupPosts.providerMessageId, pollResult: waGroupPosts.pollResult })
    .from(waGroupPosts)
    .where(
      and(
        eq(waGroupPosts.kind, "enquete"),
        gte(waGroupPosts.pollClosedAt, since),
        sql`${waGroupPosts.productIds} @> ${JSON.stringify([variant.productId])}::jsonb`,
      ),
    );
  const matches = polls.filter((poll) => {
    const winner = poll.pollResult?.winner;
    if (!winner) return false;
    const w = fold(winner);
    return [variant.color, variant.size].some((attr) => attr && (fold(attr).includes(w) || w.includes(fold(attr))));
  });
  if (matches.length === 0) return { queued: 0 };
  const targets: { postId: string; customerId: string }[] = [];
  const seen = new Set<string>();
  for (const poll of matches) {
    if (!poll.providerMessageId) continue;
    const votes = await db
      .select({ value: waGroupSignals.value, participant: waGroupSignals.participantPhone, customerId: waGroupSignals.customerId })
      .from(waGroupSignals)
      .where(and(eq(waGroupSignals.kind, "poll_vote"), eq(waGroupSignals.referencedMessageId, poll.providerMessageId)));
    const candidates = await groupCandidates(db, poll.groupId);
    for (const vote of votes) {
      if (!decodePollVote(vote.value).includes(poll.pollResult!.winner!)) continue;
      const candidate = candidates.find((c) => c.customerId === vote.customerId || c.phoneE164 === vote.participant);
      if (!candidate || seen.has(candidate.customerId)) continue;
      seen.add(candidate.customerId);
      targets.push({ postId: poll.id, customerId: candidate.customerId });
    }
  }
  if (targets.length === 0) return { queued: 0 };
  const schedule = staggerWithinWindow(targets.length, { from: now, intervalSeconds: GROUP_NOTICE_INTERVAL_SECONDS, window: policy.cadence.window });
  let queued = 0;
  for (const [index, target] of targets.entries()) {
    const id = await enqueueOutboxEvent(db, {
      eventType: GROUP_POLL_WINNER_NOTICE_EVENT,
      dedupeKey: `${GROUP_POLL_WINNER_NOTICE_EVENT}:${target.postId}:${target.customerId}`,
      aggregateType: "wa_group_post",
      aggregateId: target.postId,
      payload: { postId: target.postId, variantId: input.variantId, customerId: target.customerId },
      nextAttemptAt: schedule[index],
    });
    if (id) queued += 1;
  }
  return { queued };
}

/** Handler de wa.group_poll_winner_notice. */
export async function sendPollWinnerNotice(db: DbOrTx, provider: MessagingProvider, input: { postId: string; variantId: string; customerId: string; now?: Date }): Promise<GroupNoticeResult> {
  const now = input.now ?? new Date();
  const policy = await loadGroupPolicy(db);
  if (!policy.groupsEnabled) return { skipped: "provador_desligado" };
  const [post] = await db.select({ pollResult: waGroupPosts.pollResult, groupId: waGroupPosts.groupId }).from(waGroupPosts).where(eq(waGroupPosts.id, input.postId)).limit(1);
  const winner = post?.pollResult?.winner;
  if (!post || !winner) return { skipped: "inexistente" };
  const [variant] = await db
    .select({ name: products.name, onHand: stockLevels.onHand, reserved: stockLevels.reserved })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(stockLevels, eq(stockLevels.productVariantId, productVariants.id))
    .where(eq(productVariants.id, input.variantId))
    .limit(1);
  if (!variant) return { skipped: "inexistente" };
  const available = (variant.onHand ?? 0) - (variant.reserved ?? 0);
  if (available <= 0) return { skipped: "sem_estoque" };
  const [customer] = await db.select({ id: customers.id, fullName: customers.fullName, phoneE164: customers.phoneE164 }).from(customers).where(eq(customers.id, input.customerId)).limit(1);
  if (!customer?.phoneE164) return { skipped: "inexistente" };
  if (!canPublishNow(now, policy.cadence)) {
    await deferNotice(db, { eventType: GROUP_POLL_WINNER_NOTICE_EVENT, dedupeBase: `${GROUP_POLL_WINNER_NOTICE_EVENT}:${input.postId}:${input.customerId}`, aggregateType: "wa_group_post", aggregateId: input.postId, payload: { postId: input.postId, variantId: input.variantId, customerId: input.customerId }, now });
    return { skipped: "fora_da_janela" };
  }
  return sendTemplateMessage(db, provider, {
    templateKey: "provador_poll_winner",
    phoneE164: customer.phoneE164,
    customerId: customer.id,
    vars: { nome: firstName(customer.fullName), opcao: winner, peca: variant.name, quantidade: String(available), horas: String(policy.holdHours) },
    dedupeKey: `${GROUP_POLL_WINNER_NOTICE_EVENT}:${input.postId}:${input.customerId}`,
    requireOptIn: true,
  });
}
