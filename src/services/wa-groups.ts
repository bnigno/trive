// Provador TRIVÉ — as salas (grupos de WhatsApp da marca), quem está nelas,
// os posts rituais e os sinais que o grupo devolve. O grupo é o palco (3
// posts por semana, cadência no core); a venda acontece no privado com a
// Lia. Todo efeito externo sai pela fila (wa.group_post, wa.group_poll_close)
// e o árbitro de duplicata é o banco (dedupe_key do post, índices dos
// sinais) — nunca memória.

import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";

import type { GroupSettings, GroupSummary, MessagingProvider } from "@/adapters/zapi";
import { isProvadorCampaign, PROVADOR_CAMPAIGN_PREFIX } from "@/core/bot/site-bridge";
import { compareSizeLabels } from "@/core/catalog/measurements";
import {
  CADENCE_REFUSAL_MESSAGES,
  canPublishNow,
  canSchedulePost,
  DEFAULT_GROUP_CADENCE,
  type GroupCadencePolicy,
  type GroupPostKind,
  isPostTooLate,
  nextPublishableAt,
} from "@/core/groups/cadence";
import { DEFAULT_KILL_SWITCH_PCT, shouldTripKillSwitch } from "@/core/groups/health";
import {
  type ChegadasItem,
  groupPostProblem,
  POLL_PROBLEM_MESSAGES,
  pollProblem,
  renderChegadasPost,
  renderPoll,
  renderPollResultPost,
  renderQuemVestiuPost,
  tallyPoll,
} from "@/core/groups/rituals";
import { decodePollVote, type GroupSignal, parseGroupInbound } from "@/core/groups/signals";
import {
  auditLog,
  campaignLinks,
  customerLooks,
  customers,
  priceVersions,
  products,
  productVariants,
  siteCarts,
  stockLevels,
  waGroupMembers,
  waGroupPosts,
  waGroups,
  waGroupSignals,
} from "@/db/schema";
import { isWaLid, toWaGroupId } from "@/lib/phone";
import { spDayKey, spDayLabel, spTimeLabel } from "@/lib/sp-day";
import { type DbOrTx, enqueueOutboxEvent, kickOutbox } from "@/queue/enqueue";
import { getSettingsMap } from "@/services/settings";
import { loadSendPolicy } from "@/services/wa-send-policy";
import { isWaEnabled, siteBaseUrl } from "@/services/wa-messaging";

export class ServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
  }
}

/** As regras da casa no WhatsApp: grupo aberto (membras conversam), só admins mudam e adicionam. */
export const HOUSE_RULES: GroupSettings = {
  adminOnlyMessage: false,
  adminOnlySettings: true,
  requireAdminApproval: false,
  adminOnlyAddMember: true,
};

/** A enquete de quinta se apura sozinha depois de tanto tempo (40 h: quinta 19h → sábado 11h). */
export const POLL_CLOSE_AFTER_HOURS = 40;

/** Kill switch: pausa de 7 dias — a dona retoma antes pelo painel se quiser. */
const KILL_SWITCH_PAUSE_DAYS = 7;

// ---------------------------------------------------------------------------
// Política e settings
// ---------------------------------------------------------------------------

export type GroupPolicy = {
  groupsEnabled: boolean;
  mentionsEnabled: boolean;
  cadence: GroupCadencePolicy;
  killSwitchPct: number;
  holdHours: number;
};

export async function loadGroupPolicy(db: DbOrTx): Promise<GroupPolicy> {
  const [map, send] = await Promise.all([
    getSettingsMap(db, ["groups_enabled", "bot_group_mentions_enabled", "group_posts_per_week", "group_kill_switch_pct", "hold_ttl_hours"]),
    loadSendPolicy(db),
  ]);
  const perWeek = Number(map["group_posts_per_week"]);
  const pct = Number(map["group_kill_switch_pct"]);
  const hold = Number(map["hold_ttl_hours"]);
  return {
    groupsEnabled: map["groups_enabled"] === true,
    mentionsEnabled: map["bot_group_mentions_enabled"] === true,
    cadence: {
      ...DEFAULT_GROUP_CADENCE,
      postsPerWeek: Number.isFinite(perWeek) && perWeek > 0 ? perWeek : DEFAULT_GROUP_CADENCE.postsPerWeek,
      window: send.window,
    },
    killSwitchPct: Number.isFinite(pct) && pct >= 0 ? pct : DEFAULT_KILL_SWITCH_PCT,
    holdHours: Number.isFinite(hold) && hold > 0 ? hold : 24,
  };
}

// ---------------------------------------------------------------------------
// Salas
// ---------------------------------------------------------------------------

export type GroupView = {
  id: string;
  providerGroupId: string;
  name: string;
  kind: string;
  cityEditionId: string | null;
  invitationLink: string | null;
  isActive: boolean;
  pausedUntil: Date | null;
  pausedReason: string | null;
  memberCount: number;
  lastSyncedAt: Date | null;
  createdAt: Date;
};

function toGroupView(row: typeof waGroups.$inferSelect): GroupView {
  return {
    id: row.id,
    providerGroupId: row.providerGroupId,
    name: row.name,
    kind: row.kind,
    cityEditionId: row.cityEditionId,
    invitationLink: row.invitationLink,
    isActive: row.isActive,
    pausedUntil: row.pausedUntil,
    pausedReason: row.pausedReason,
    memberCount: row.memberCount,
    lastSyncedAt: row.lastSyncedAt,
    createdAt: row.createdAt,
  };
}

export async function listGroups(db: DbOrTx): Promise<GroupView[]> {
  const rows = await db.select().from(waGroups).orderBy(desc(waGroups.isActive), asc(waGroups.createdAt));
  return rows.map(toGroupView);
}

export async function getGroup(db: DbOrTx, groupId: string): Promise<GroupView | null> {
  const [row] = await db.select().from(waGroups).where(eq(waGroups.id, groupId)).limit(1);
  return row ? toGroupView(row) : null;
}

/** Os grupos de que o WhatsApp da loja participa, com a marca de "já registrado". */
export async function listProviderGroups(
  db: DbOrTx,
  provider: MessagingProvider,
): Promise<(GroupSummary & { registeredId: string | null })[]> {
  const [remote, local] = await Promise.all([provider.listGroups(), db.select({ id: waGroups.id, providerGroupId: waGroups.providerGroupId }).from(waGroups)]);
  const known = new Map(local.map((row) => [row.providerGroupId, row.id]));
  return remote.map((group) => ({ ...group, registeredId: known.get(group.groupId) ?? null }));
}

const registerGroupSchema = z.object({
  providerGroupId: z.string().trim().min(1),
  kind: z.enum(["provador", "turma"]).default("provador"),
  cityEditionId: z.uuid().nullable().optional(),
  userId: z.uuid(),
});
export type RegisterGroupInput = z.input<typeof registerGroupSchema>;

/**
 * Registra uma sala a partir de um grupo que já existe no WhatsApp da loja
 * (criado à mão pela dona): lê nome, link e participantes do metadata e
 * aplica as regras da casa. Registrar de novo o mesmo grupo devolve a sala
 * existente.
 */
export async function registerGroup(db: DbOrTx, provider: MessagingProvider, rawInput: RegisterGroupInput): Promise<GroupView> {
  const input = registerGroupSchema.parse(rawInput);
  const providerGroupId = toWaGroupId(input.providerGroupId);
  if (!providerGroupId) throw new ServiceError("grupo_invalido", "Isso não é um id de grupo do WhatsApp.");

  const [existing] = await db.select().from(waGroups).where(eq(waGroups.providerGroupId, providerGroupId)).limit(1);
  if (existing) return toGroupView(existing);

  const metadata = await provider.getGroupMetadata(providerGroupId);
  const now = new Date();
  const [row] = await db
    .insert(waGroups)
    .values({
      providerGroupId,
      name: metadata.name ?? "Provador",
      kind: input.kind,
      cityEditionId: input.cityEditionId ?? null,
      invitationLink: metadata.invitationLink,
      memberCount: metadata.participants.length,
      lastSyncedAt: now,
      createdBy: input.userId,
    })
    .returning();
  await db.insert(auditLog).values({
    actorType: "user",
    actorId: input.userId,
    action: "wa_group.register",
    entityType: "wa_group",
    entityId: row.id,
    after: { providerGroupId, name: row.name, kind: row.kind, members: metadata.participants.length },
  });
  await syncMembersFromMetadata(db, row.id, metadata.participants, now);
  return toGroupView(row);
}

/** As regras da casa no grupo (exige a sessão da loja como admin). */
export async function applyHouseRules(db: DbOrTx, provider: MessagingProvider, input: { groupId: string; userId: string }): Promise<void> {
  const group = await getGroup(db, input.groupId);
  if (!group) throw new ServiceError("sala_inexistente", "Essa sala não existe.");
  await provider.updateGroupSettings(group.providerGroupId, HOUSE_RULES);
  await db.insert(auditLog).values({
    actorType: "user",
    actorId: input.userId,
    action: "wa_group.house_rules",
    entityType: "wa_group",
    entityId: group.id,
    after: { ...HOUSE_RULES },
  });
}

export async function refreshInvitationLink(db: DbOrTx, provider: MessagingProvider, input: { groupId: string }): Promise<string | null> {
  const group = await getGroup(db, input.groupId);
  if (!group) throw new ServiceError("sala_inexistente", "Essa sala não existe.");
  const link = await provider.getGroupInvitationLink(group.providerGroupId);
  await db.update(waGroups).set({ invitationLink: link, updatedAt: new Date() }).where(eq(waGroups.id, group.id));
  return link;
}

export async function setGroupActive(db: DbOrTx, input: { groupId: string; isActive: boolean; userId: string }): Promise<void> {
  const now = new Date();
  const [row] = await db
    .update(waGroups)
    .set({ isActive: input.isActive, updatedAt: now })
    .where(eq(waGroups.id, input.groupId))
    .returning({ id: waGroups.id });
  if (!row) throw new ServiceError("sala_inexistente", "Essa sala não existe.");
  await db.insert(auditLog).values({
    actorType: "user",
    actorId: input.userId,
    action: input.isActive ? "wa_group.activate" : "wa_group.deactivate",
    entityType: "wa_group",
    entityId: row.id,
  });
}

export async function pauseGroup(
  db: DbOrTx,
  input: { groupId: string; until: Date; reason: string; actor: { type: "user"; id: string } | { type: "system" } },
): Promise<void> {
  const now = new Date();
  const [row] = await db
    .update(waGroups)
    .set({ pausedUntil: input.until, pausedReason: input.reason, updatedAt: now })
    .where(eq(waGroups.id, input.groupId))
    .returning({ id: waGroups.id });
  if (!row) throw new ServiceError("sala_inexistente", "Essa sala não existe.");
  await db.insert(auditLog).values({
    actorType: input.actor.type,
    actorId: input.actor.type === "user" ? input.actor.id : null,
    action: "wa_group.pause",
    entityType: "wa_group",
    entityId: row.id,
    after: { until: input.until.toISOString(), reason: input.reason },
  });
}

export async function resumeGroup(db: DbOrTx, input: { groupId: string; userId: string }): Promise<void> {
  const [row] = await db
    .update(waGroups)
    .set({ pausedUntil: null, pausedReason: null, updatedAt: new Date() })
    .where(eq(waGroups.id, input.groupId))
    .returning({ id: waGroups.id });
  if (!row) throw new ServiceError("sala_inexistente", "Essa sala não existe.");
  await db.insert(auditLog).values({
    actorType: "user",
    actorId: input.userId,
    action: "wa_group.resume",
    entityType: "wa_group",
    entityId: row.id,
  });
}

function isPaused(group: { pausedUntil: Date | null }, now: Date): boolean {
  return group.pausedUntil !== null && group.pausedUntil.getTime() > now.getTime();
}

// ---------------------------------------------------------------------------
// Membras — sincronizadas do metadata da Z-API (entradas, saídas, kill switch)
// ---------------------------------------------------------------------------

type ParticipantLike = { phoneE164: string | null; lid: string | null; isAdmin: boolean };

/** O endereço de conversa da participante: telefone quando existe, senão o LID. */
function participantKey(participant: ParticipantLike): string | null {
  return participant.phoneE164 ?? participant.lid;
}

/**
 * Casa a lista do metadata com as linhas da sala. A mesma pessoa pode vir
 * hoje pelo telefone e amanhã pelo LID (o WhatsApp esconde o número quando
 * quer): a linha é encontrada por QUALQUER um dos dois, e a que nasceu pelo
 * LID sobe para o telefone quando ele aparece — senão cada troca viraria
 * uma "saída" (e o kill switch pausaria a sala por engano).
 */
async function syncMembersFromMetadata(
  db: DbOrTx,
  groupId: string,
  participants: readonly ParticipantLike[],
  now: Date,
): Promise<{ joined: number; left: number; total: number }> {
  const present = new Map<string, ParticipantLike>();
  for (const participant of participants) {
    const key = participantKey(participant);
    if (key) present.set(key, participant);
  }
  const rows = await db
    .select({ id: waGroupMembers.id, phoneE164: waGroupMembers.phoneE164, lid: waGroupMembers.lid, leftAt: waGroupMembers.leftAt })
    .from(waGroupMembers)
    .where(eq(waGroupMembers.groupId, groupId));
  const knownByPhone = new Map(rows.map((row) => [row.phoneE164, row]));
  const knownByLid = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (row.lid) knownByLid.set(row.lid, row);
    if (isWaLid(row.phoneE164)) knownByLid.set(row.phoneE164, row);
  }
  const matched = new Set<string>();

  let joined = 0;
  let left = 0;
  for (const [key, participant] of present) {
    let row = knownByPhone.get(key);
    // Pelo LID: a linha que só tinha o LID e agora veio com telefone, ou a
    // linha com telefone que hoje veio só pelo LID — a mesma pessoa.
    if (!row && participant.lid) {
      const byLid = knownByLid.get(participant.lid);
      if (byLid && !matched.has(byLid.id)) row = byLid;
    }
    if (!row) {
      const [customer] = participant.phoneE164
        ? await db
            .select({ id: customers.id })
            .from(customers)
            .where(and(eq(customers.phoneE164, participant.phoneE164), isNull(customers.deletedAt)))
            .limit(1)
        : [];
      await db.insert(waGroupMembers).values({
        groupId,
        phoneE164: key,
        lid: participant.phoneE164 ? participant.lid : null,
        customerId: customer?.id ?? null,
        isAdmin: participant.isAdmin,
        source: "sync",
        joinedAt: now,
      });
      joined += 1;
      continue;
    }
    matched.add(row.id);
    // O telefone é o endereço melhor: a linha sobe do LID para ele, nunca o contrário.
    const identity = participant.phoneE164
      ? row.phoneE164 !== participant.phoneE164
        ? { phoneE164: participant.phoneE164, lid: participant.lid }
        : row.lid !== participant.lid && participant.lid
          ? { lid: participant.lid }
          : {}
      : {};
    if (row.leftAt !== null) {
      await db
        .update(waGroupMembers)
        .set({ ...identity, leftAt: null, leftReason: null, joinedAt: now, isAdmin: participant.isAdmin, updatedAt: now })
        .where(eq(waGroupMembers.id, row.id));
      joined += 1;
    } else {
      await db.update(waGroupMembers).set({ ...identity, isAdmin: participant.isAdmin, updatedAt: now }).where(eq(waGroupMembers.id, row.id));
    }
  }
  for (const row of rows) {
    if (row.leftAt === null && !matched.has(row.id)) {
      await db
        .update(waGroupMembers)
        .set({ leftAt: now, leftReason: "saiu", updatedAt: now })
        .where(eq(waGroupMembers.id, row.id));
      left += 1;
    }
  }
  await db
    .update(waGroups)
    .set({ memberCount: present.size, lastSyncedAt: now, updatedAt: now })
    .where(eq(waGroups.id, groupId));
  return { joined, left, total: present.size };
}

export type SyncGroupResult = { joined: number; left: number; total: number; paused: boolean };

/**
 * Lê o metadata do grupo e aplica entradas e saídas. Depois olha o kill
 * switch: saídas nas 24 h seguintes ao último post acima do % param a sala
 * por 7 dias e avisam a dona (uma vez por post, pelo dedupe do aviso).
 */
export async function syncGroupMembers(db: DbOrTx, provider: MessagingProvider, input: { groupId: string; now?: Date }): Promise<SyncGroupResult> {
  const now = input.now ?? new Date();
  const [group] = await db.select().from(waGroups).where(eq(waGroups.id, input.groupId)).limit(1);
  if (!group) throw new ServiceError("sala_inexistente", "Essa sala não existe.");
  const metadata = await provider.getGroupMetadata(group.providerGroupId);
  const result = await syncMembersFromMetadata(db, group.id, metadata.participants, now);
  if (metadata.name && metadata.name !== group.name) {
    await db.update(waGroups).set({ name: metadata.name, updatedAt: now }).where(eq(waGroups.id, group.id));
  }
  const paused = await checkKillSwitch(db, { ...group, memberCount: result.total }, now);
  return { ...result, paused };
}

async function checkKillSwitch(db: DbOrTx, group: typeof waGroups.$inferSelect, now: Date): Promise<boolean> {
  if (isPaused(group, now)) return true;
  const policy = await loadGroupPolicy(db);
  if (policy.killSwitchPct <= 0) return false;
  const [lastPost] = await db
    .select({ id: waGroupPosts.id, sentAt: waGroupPosts.sentAt, kind: waGroupPosts.kind })
    .from(waGroupPosts)
    .where(and(eq(waGroupPosts.groupId, group.id), eq(waGroupPosts.status, "sent")))
    .orderBy(desc(waGroupPosts.sentAt))
    .limit(1);
  if (!lastPost?.sentAt) return false;
  const windowEnd = lastPost.sentAt.getTime() + 24 * 3_600_000;
  if (now.getTime() > windowEnd) return false;
  const [{ leaves }] = await db
    .select({ leaves: sql<number>`count(*)::int` })
    .from(waGroupMembers)
    .where(and(eq(waGroupMembers.groupId, group.id), gte(waGroupMembers.leftAt, lastPost.sentAt), eq(waGroupMembers.leftReason, "saiu")));
  const members = group.memberCount + leaves;
  if (!shouldTripKillSwitch({ leaves, members, pct: policy.killSwitchPct })) return false;

  const until = new Date(now.getTime() + KILL_SWITCH_PAUSE_DAYS * 86_400_000);
  const reason = `${leaves} de ${members} saíram nas 24 h depois do post de ${lastPost.kind}`;
  await pauseGroup(db, { groupId: group.id, until, reason, actor: { type: "system" } });
  await enqueueOutboxEvent(db, {
    eventType: "wa.owner_forward",
    dedupeKey: `wa.group_kill_switch:${lastPost.id}`,
    aggregateType: "wa_group",
    aggregateId: group.id,
    payload: {
      raw: true,
      dedupeKey: `wa.group_kill_switch:${lastPost.id}`,
      body: `⏸️ Pausei o ${group.name}: ${reason}. Os próximos posts ficam parados por ${KILL_SWITCH_PAUSE_DAYS} dias. Se foi você que removeu essas pessoas, é só retomar pelo painel; se saíram sozinhas, vale olhar o post antes de retomar.`,
    },
  });
  return true;
}

/** Cron: todas as salas ativas, uma por vez (erro numa não derruba as outras). */
export async function syncAllGroups(db: DbOrTx, provider: MessagingProvider, input: { now?: Date } = {}): Promise<{ synced: number; failed: number }> {
  const policy = await loadGroupPolicy(db);
  if (!policy.groupsEnabled) return { synced: 0, failed: 0 };
  const rows = await db.select({ id: waGroups.id }).from(waGroups).where(eq(waGroups.isActive, true));
  let synced = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await syncGroupMembers(db, provider, { groupId: row.id, now: input.now });
      synced += 1;
    } catch (error) {
      failed += 1;
      console.warn(`[wa-groups] sync da sala ${row.id} falhou:`, error);
    }
  }
  return { synced, failed };
}

export type GroupMemberView = {
  id: string;
  phoneE164: string;
  customerId: string | null;
  customerName: string | null;
  isAdmin: boolean;
  source: string;
  joinedAt: Date;
  leftAt: Date | null;
  leftReason: string | null;
  marketingOptIn: boolean;
  hasProfile: boolean;
};

export async function listGroupMembers(db: DbOrTx, input: { groupId: string; includeLeft?: boolean }): Promise<GroupMemberView[]> {
  const rows = await db
    .select({
      id: waGroupMembers.id,
      phoneE164: waGroupMembers.phoneE164,
      customerId: waGroupMembers.customerId,
      customerName: customers.fullName,
      marketingOptIn: customers.marketingOptIn,
      isAdmin: waGroupMembers.isAdmin,
      source: waGroupMembers.source,
      joinedAt: waGroupMembers.joinedAt,
      leftAt: waGroupMembers.leftAt,
      leftReason: waGroupMembers.leftReason,
      hasProfile: sql<boolean>`exists (select 1 from customer_profiles p where p.phone_e164 = ${waGroupMembers.phoneE164} and p.forgotten_at is null)`,
    })
    .from(waGroupMembers)
    .leftJoin(customers, eq(customers.id, waGroupMembers.customerId))
    .where(input.includeLeft ? eq(waGroupMembers.groupId, input.groupId) : and(eq(waGroupMembers.groupId, input.groupId), isNull(waGroupMembers.leftAt)))
    .orderBy(desc(waGroupMembers.joinedAt));
  return rows.map((row) => ({
    id: row.id,
    phoneE164: row.phoneE164,
    customerId: row.customerId,
    customerName: row.customerName ?? null,
    isAdmin: row.isAdmin,
    source: row.source,
    joinedAt: row.joinedAt,
    leftAt: row.leftAt,
    leftReason: row.leftReason,
    marketingOptIn: row.marketingOptIn === true,
    hasProfile: row.hasProfile === true,
  }));
}

// ---------------------------------------------------------------------------
// Posts — compor (pré-visualização), agendar, cancelar, listar
// ---------------------------------------------------------------------------

const composePostSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("chegadas"),
    productIds: z.array(z.uuid()).min(1, "Escolha pelo menos uma peça.").max(3, "No máximo 3 peças por post."),
    /** "amanhã às 9h" — quando vão para a vitrine; vazio = já estão. */
    vitrineWhen: z.string().trim().max(60).optional(),
  }),
  z.object({
    kind: z.literal("enquete"),
    // Pergunta e opções são validadas por pollProblem (core), que devolve o
    // problema na ordem em que a dona corrige.
    question: z.string().trim(),
    options: z.array(z.string().trim()),
    maxOptions: z.number().int().min(1).max(12).optional(),
    outcome: z.string().trim().max(80).optional(),
    voterHoldHours: z.number().int().min(0).max(168).optional(),
  }),
  z.object({
    kind: z.literal("quem_vestiu"),
    lookIds: z.array(z.uuid()).min(1, "Escolha pelo menos um look.").max(2, "No máximo 2 looks por post."),
    photoCoupon: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("cortina"),
    body: z.string().trim().min(1, "Escreva o post."),
    dropId: z.uuid(),
    imageUrl: z.url().optional(),
  }),
  z.object({
    kind: z.literal("livre"),
    body: z.string().trim().min(1, "Escreva o post."),
    imageUrl: z.url().optional(),
  }),
]);
export type ComposeGroupPostInput = z.input<typeof composePostSchema>;

export type ComposedGroupPost = {
  kind: GroupPostKind;
  body: string;
  /** O slug do link rastreável do post (prov-YYYYMMDD-<ritual>) e a URL que vai no texto. */
  slug: string;
  link: string;
  imageUrl: string | null;
  pollOptions: string[] | null;
  pollMaxOptions: number | null;
  productIds: string[] | null;
  lookIds: string[] | null;
  dropId: string | null;
  /** O rótulo humano do link ("Provador · chegadas 22/09"). */
  linkLabel: string;
};

const RITUAL_SLUG: Record<GroupPostKind, string> = {
  chegadas: "chegadas",
  enquete: "enquete",
  quem_vestiu: "vestiu",
  cortina: "cortina",
  livre: "post",
};

const RITUAL_LABEL: Record<GroupPostKind, string> = {
  chegadas: "chegadas",
  enquete: "enquete",
  quem_vestiu: "quem vestiu",
  cortina: "cortina",
  livre: "post",
};

/** prov-20260922-chegadas — um por ritual e dia; a URL entra no texto antes de o link existir. */
export function provadorSlug(kind: GroupPostKind, day: string): string {
  return `${PROVADOR_CAMPAIGN_PREFIX}${day.replace(/-/g, "")}-${RITUAL_SLUG[kind]}`;
}

function provadorLinkLabel(kind: GroupPostKind, day: string): string {
  const [, month, dayOfMonth] = day.split("-");
  return `Provador · ${RITUAL_LABEL[kind]} ${dayOfMonth}/${month}`;
}

async function loadChegadasItems(db: DbOrTx, productIds: readonly string[]): Promise<ChegadasItem[]> {
  const rows = await db
    .select({
      productId: products.id,
      name: products.name,
      size: sql<string | null>`${productVariants.attributes} ->> 'tamanho'`,
      priceCents: priceVersions.priceCents,
      available: sql<string>`coalesce(${stockLevels.onHand}, 0) - coalesce(${stockLevels.reserved}, 0)`,
    })
    .from(products)
    .innerJoin(productVariants, and(eq(productVariants.productId, products.id), eq(productVariants.isActive, true), isNull(productVariants.deletedAt)))
    .innerJoin(priceVersions, and(eq(priceVersions.productVariantId, productVariants.id), eq(priceVersions.status, "active")))
    .leftJoin(stockLevels, eq(stockLevels.productVariantId, productVariants.id))
    .where(and(inArray(products.id, [...productIds]), isNull(products.deletedAt)));

  const byProduct = new Map<string, { name: string; priceCents: number; sizes: Map<string, number> }>();
  for (const row of rows) {
    const entry =
      byProduct.get(row.productId) ??
      byProduct.set(row.productId, { name: row.name, priceCents: Number(row.priceCents), sizes: new Map() }).get(row.productId)!;
    entry.priceCents = Math.min(entry.priceCents, Number(row.priceCents));
    const size = row.size?.trim() || "único";
    entry.sizes.set(size, (entry.sizes.get(size) ?? 0) + Math.max(0, Number(row.available)));
  }
  const items: ChegadasItem[] = [];
  for (const productId of productIds) {
    const entry = byProduct.get(productId);
    if (!entry) throw new ServiceError("peca_inexistente", "Uma das peças não existe mais ou não tem preço ativo.");
    const stockBySize = [...entry.sizes.entries()]
      .map(([size, quantity]) => ({ size, quantity }))
      .sort((a, b) => compareSizeLabels(a.size, b.size));
    if (!stockBySize.some((entry) => entry.quantity > 0)) {
      throw new ServiceError("peca_sem_estoque", `"${entry.name}" está sem estoque — o Provador só mostra o que tem.`);
    }
    items.push({ name: entry.name, priceCents: entry.priceCents, stockBySize });
  }
  return items;
}

async function loadLooks(db: DbOrTx, lookIds: readonly string[]) {
  const rows = await db
    .select({
      id: customerLooks.id,
      displayName: customerLooks.displayName,
      productName: products.name,
      size: sql<string | null>`${productVariants.attributes} ->> 'tamanho'`,
      consentAnswer: customerLooks.consentAnswer,
      approvedAt: customerLooks.approvedAt,
      revokedAt: customerLooks.revokedAt,
    })
    .from(customerLooks)
    .innerJoin(products, eq(products.id, customerLooks.productId))
    .leftJoin(productVariants, eq(productVariants.id, customerLooks.productVariantId))
    .where(inArray(customerLooks.id, [...lookIds]));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return lookIds.map((id) => {
    const row = byId.get(id);
    if (!row) throw new ServiceError("look_inexistente", "Um dos looks não existe mais.");
    // A mesma régua da vitrine: só com o sim dela, aprovado pela dona e não retirado.
    if (row.consentAnswer !== "sim" || !row.approvedAt || row.revokedAt) {
      throw new ServiceError("look_sem_consentimento", `O look de ${row.displayName} não pode aparecer: falta o sim dela ou a aprovação.`);
    }
    return { firstName: row.displayName, productName: row.productName, size: row.size };
  });
}

/**
 * Monta o post (o texto exato que vai sair) a partir dos dados — é a mesma
 * função da pré-visualização e do agendamento, para o painel mostrar o que
 * o grupo vai receber. `day` é o dia SP do envio (define o slug do link).
 */
export async function composeGroupPost(
  db: DbOrTx,
  rawInput: ComposeGroupPostInput,
  opts: { day: string; holdHours?: number },
): Promise<ComposedGroupPost> {
  const input = composePostSchema.parse(rawInput);
  const slug = provadorSlug(input.kind, opts.day);
  const link = `${siteBaseUrl()}/ig/${slug}`;
  const base = {
    kind: input.kind,
    slug,
    link,
    linkLabel: provadorLinkLabel(input.kind, opts.day),
    imageUrl: null,
    pollOptions: null,
    pollMaxOptions: null,
    productIds: null,
    lookIds: null,
    dropId: null,
  };
  switch (input.kind) {
    case "chegadas": {
      const items = await loadChegadasItems(db, input.productIds);
      return {
        ...base,
        productIds: [...input.productIds],
        body: renderChegadasPost({
          items,
          liaLink: link,
          ...(input.vitrineWhen ? { vitrineWhen: input.vitrineWhen } : {}),
          holdHours: opts.holdHours ?? 24,
          // A proteção de preço entra aqui quando a Onda 6 (cupons) ligar a regra;
          // até lá o Provador não promete o que a loja ainda não cumpre.
          priceProtectionDays: null,
        }),
      };
    }
    case "enquete": {
      const problem = pollProblem(input);
      if (problem) throw new ServiceError(`enquete_${problem}`, POLL_PROBLEM_MESSAGES[problem]);
      const poll = renderPoll(input);
      return { ...base, body: poll.message, pollOptions: poll.options, pollMaxOptions: input.maxOptions ?? 1 };
    }
    case "quem_vestiu": {
      const looks = await loadLooks(db, input.lookIds);
      const policy = await loadSendPolicy(db);
      return {
        ...base,
        lookIds: [...input.lookIds],
        body: renderQuemVestiuPost({ looks, liaLink: link, until: `${policy.window.endHour}h`, photoCoupon: input.photoCoupon === true }),
      };
    }
    case "cortina":
      return { ...base, body: input.body, dropId: input.dropId, imageUrl: input.imageUrl ?? null };
    case "livre":
      return { ...base, body: input.body, imageUrl: input.imageUrl ?? null };
  }
}

const schedulePostSchema = z.object({
  groupId: z.uuid(),
  /** null = agora (a fila manda no próximo ciclo). */
  scheduledAt: z.date().nullable(),
  userId: z.uuid(),
});
export type ScheduleGroupPostInput = z.input<typeof schedulePostSchema> & { post: ComposeGroupPostInput };

export type GroupPostView = {
  id: string;
  groupId: string;
  kind: string;
  status: string;
  scheduledAt: Date | null;
  sentAt: Date | null;
  body: string;
  imageUrl: string | null;
  pollOptions: string[] | null;
  pollMaxOptions: number | null;
  pollClosedAt: Date | null;
  pollResult: { tally: { option: string; votes: number }[]; winner: string | null; voters: number; resultMessageId: string | null } | null;
  productIds: string[] | null;
  lookIds: string[] | null;
  dropId: string | null;
  campaignLinkId: string | null;
  campaignSlug: string | null;
  providerMessageId: string | null;
  skippedReason: string | null;
  createdAt: Date;
};

function toPostView(row: typeof waGroupPosts.$inferSelect, campaignSlug: string | null): GroupPostView {
  return {
    id: row.id,
    groupId: row.groupId,
    kind: row.kind,
    status: row.status,
    scheduledAt: row.scheduledAt,
    sentAt: row.sentAt,
    body: row.body,
    imageUrl: row.imageUrl,
    pollOptions: row.pollOptions,
    pollMaxOptions: row.pollMaxOptions,
    pollClosedAt: row.pollClosedAt,
    pollResult: row.pollResult,
    productIds: row.productIds,
    lookIds: row.lookIds,
    dropId: row.dropId,
    campaignLinkId: row.campaignLinkId,
    campaignSlug,
    providerMessageId: row.providerMessageId,
    skippedReason: row.skippedReason,
    createdAt: row.createdAt,
  };
}

/** O link rastreável do post: reaproveita o do mesmo ritual e dia (reagendar não cria outro). */
async function ensureCampaignLink(db: DbOrTx, input: { slug: string; label: string; productId: string | null; userId: string }): Promise<string> {
  const [existing] = await db.select({ id: campaignLinks.id }).from(campaignLinks).where(eq(campaignLinks.slug, input.slug)).limit(1);
  if (existing) return existing.id;
  const [row] = await db
    .insert(campaignLinks)
    .values({ slug: input.slug, label: input.label, productId: input.productId, createdBy: input.userId })
    .onConflictDoNothing({ target: campaignLinks.slug })
    .returning({ id: campaignLinks.id });
  if (row) return row.id;
  const [raced] = await db.select({ id: campaignLinks.id }).from(campaignLinks).where(eq(campaignLinks.slug, input.slug)).limit(1);
  return raced!.id;
}

/**
 * Agenda (ou manda agora) um post do Provador. A cadência do core decide se
 * cabe; o post nasce 'scheduled' e o evento wa.group_post com next_attempt_at
 * na hora marcada — o handler confere tudo de novo na hora de enviar.
 */
export async function scheduleGroupPost(db: DbOrTx, rawInput: ScheduleGroupPostInput, opts: { now?: Date } = {}): Promise<GroupPostView> {
  const input = schedulePostSchema.parse(rawInput);
  const now = opts.now ?? new Date();
  const scheduledAt = input.scheduledAt ?? now;

  const [group] = await db.select().from(waGroups).where(eq(waGroups.id, input.groupId)).limit(1);
  if (!group) throw new ServiceError("sala_inexistente", "Essa sala não existe.");
  if (!group.isActive) throw new ServiceError("sala_inativa", "Essa sala está desligada.");

  const policy = await loadGroupPolicy(db);
  const others = await db
    .select({ scheduledAt: waGroupPosts.scheduledAt, sentAt: waGroupPosts.sentAt })
    .from(waGroupPosts)
    .where(and(eq(waGroupPosts.groupId, group.id), inArray(waGroupPosts.status, ["scheduled", "sent"])));
  // Um post agendado que a fila nunca entregou (provedor fora do ar) não
  // segura o dia nem a semana: a dona vê "não saiu" no painel e reagenda.
  const existing = others
    .map((row) => row.sentAt ?? row.scheduledAt)
    .filter((date): date is Date => date !== null)
    .filter((date, index) => others[index]!.sentAt !== null || !isPostTooLate(date, now));
  const verdict = canSchedulePost({ candidateAt: scheduledAt, existing, now, policy: policy.cadence });
  if (!verdict.ok) throw new ServiceError(`cadencia_${verdict.reason}`, CADENCE_REFUSAL_MESSAGES[verdict.reason]);

  const composed = await composeGroupPost(db, rawInput.post, { day: spDayKey(scheduledAt), holdHours: policy.holdHours });
  const problem = groupPostProblem(composed.body);
  if (problem) throw new ServiceError("post_invalido", problem);

  const postId = randomUUID();
  const dedupeKey = `wa.group_post:${postId}`;
  const view = await db.transaction(async (tx) => {
    const campaignLinkId = await ensureCampaignLink(tx, {
      slug: composed.slug,
      label: composed.linkLabel,
      productId: composed.productIds?.[0] ?? null,
      userId: input.userId,
    });
    const [row] = await tx
      .insert(waGroupPosts)
      .values({
        id: postId,
        groupId: group.id,
        kind: composed.kind,
        status: "scheduled",
        scheduledAt,
        body: composed.body,
        imageUrl: composed.imageUrl,
        pollOptions: composed.pollOptions,
        pollMaxOptions: composed.pollMaxOptions,
        productIds: composed.productIds,
        lookIds: composed.lookIds,
        dropId: composed.dropId,
        campaignLinkId,
        dedupeKey,
        createdBy: input.userId,
      })
      .returning();
    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: input.userId,
      action: "wa_group_post.schedule",
      entityType: "wa_group_post",
      entityId: row.id,
      after: { groupId: group.id, kind: row.kind, scheduledAt: scheduledAt.toISOString(), slug: composed.slug },
    });
    await enqueueOutboxEvent(
      tx,
      {
        eventType: "wa.group_post",
        dedupeKey,
        aggregateType: "wa_group_post",
        aggregateId: row.id,
        payload: { postId: row.id },
        nextAttemptAt: scheduledAt,
      },
      { kick: false },
    );
    return toPostView(row, composed.slug);
  });
  // O kick só depois do commit: dentro da transação a fila não acha a linha.
  if (scheduledAt.getTime() <= now.getTime() + 60_000) await kickOutbox(undefined, { eventType: "wa.group_post" });
  return view;
}

export async function cancelGroupPost(db: DbOrTx, input: { postId: string; userId: string }): Promise<void> {
  const now = new Date();
  const [row] = await db
    .update(waGroupPosts)
    .set({ status: "canceled", updatedAt: now })
    .where(and(eq(waGroupPosts.id, input.postId), inArray(waGroupPosts.status, ["draft", "scheduled"])))
    .returning({ id: waGroupPosts.id });
  if (!row) throw new ServiceError("post_nao_cancelavel", "Esse post já saiu (ou já foi cancelado).");
  await db.insert(auditLog).values({
    actorType: "user",
    actorId: input.userId,
    action: "wa_group_post.cancel",
    entityType: "wa_group_post",
    entityId: row.id,
  });
}

export async function listGroupPosts(db: DbOrTx, input: { groupId: string; from?: Date; to?: Date; limit?: number }): Promise<GroupPostView[]> {
  const conditions = [eq(waGroupPosts.groupId, input.groupId)];
  const when = sql`coalesce(${waGroupPosts.sentAt}, ${waGroupPosts.scheduledAt}, ${waGroupPosts.createdAt})`;
  if (input.from) conditions.push(gte(when, input.from));
  if (input.to) conditions.push(lte(when, input.to));
  const rows = await db
    .select({ post: waGroupPosts, slug: campaignLinks.slug })
    .from(waGroupPosts)
    .leftJoin(campaignLinks, eq(campaignLinks.id, waGroupPosts.campaignLinkId))
    .where(and(...conditions))
    .orderBy(desc(when))
    .limit(input.limit ?? 50);
  return rows.map((row) => toPostView(row.post, row.slug ?? null));
}

export async function getGroupPost(db: DbOrTx, postId: string): Promise<GroupPostView | null> {
  const [row] = await db
    .select({ post: waGroupPosts, slug: campaignLinks.slug })
    .from(waGroupPosts)
    .leftJoin(campaignLinks, eq(campaignLinks.id, waGroupPosts.campaignLinkId))
    .where(eq(waGroupPosts.id, postId))
    .limit(1);
  return row ? toPostView(row.post, row.slug ?? null) : null;
}

// ---------------------------------------------------------------------------
// sendGroupPost — handler de wa.group_post
// ---------------------------------------------------------------------------

export const groupPostPayloadSchema = z.object({ postId: z.uuid() });
export const groupPollClosePayloadSchema = z.object({ postId: z.uuid() });

export type SendGroupPostSkip =
  | "inexistente"
  | "ja_enviado"
  | "cancelado"
  | "provador_desligado"
  | "desabilitado"
  | "sala_inativa"
  | "sala_pausada"
  | "atrasado"
  | "fora_da_janela";

const SKIP_OWNER_NOTICE: Partial<Record<SendGroupPostSkip, string>> = {
  atrasado: "a fila só chegou horas depois da hora marcada",
  fora_da_janela: "a fila só chegou depois do fim da janela de envio",
  desabilitado: "o WhatsApp automático estava desligado",
  provador_desligado: "o Provador estava desligado",
};

export type SendGroupPostResult = { sent: true; providerMessageId: string } | { skipped: SendGroupPostSkip };

/**
 * Manda o post no grupo. Skips NUNCA lançam (o evento encerra); só falha
 * REAL do provedor lança e a fila tenta de novo — o post é o próprio
 * árbitro: com provider_message_id gravado, não sai de novo.
 */
export async function sendGroupPost(db: DbOrTx, provider: MessagingProvider, input: { postId: string; now?: Date }): Promise<SendGroupPostResult> {
  const now = input.now ?? new Date();
  const [row] = await db
    .select({ post: waGroupPosts, group: waGroups })
    .from(waGroupPosts)
    .innerJoin(waGroups, eq(waGroups.id, waGroupPosts.groupId))
    .where(eq(waGroupPosts.id, input.postId))
    .limit(1);
  if (!row) return { skipped: "inexistente" };
  const { post, group } = row;
  if (post.status === "sent" || post.providerMessageId) return { skipped: "ja_enviado" };
  if (post.status === "canceled") return { skipped: "cancelado" };

  // Skip definitivo: o post fica 'skipped' com o motivo (a dona vê no painel
  // e agenda de novo se quiser); o evento encerra sem lançar. Quando o post
  // deveria ter saído e não saiu por causa da máquina, a dona é avisada.
  const skip = async (reason: SendGroupPostSkip): Promise<SendGroupPostResult> => {
    await db.update(waGroupPosts).set({ status: "skipped", skippedReason: reason, updatedAt: now }).where(eq(waGroupPosts.id, post.id));
    const why = SKIP_OWNER_NOTICE[reason];
    if (why && post.scheduledAt) {
      await enqueueOutboxEvent(db, {
        eventType: "wa.owner_forward",
        dedupeKey: `wa.group_post_skipped:${post.id}`,
        aggregateType: "wa_group_post",
        aggregateId: post.id,
        payload: {
          raw: true,
          dedupeKey: `wa.group_post_skipped:${post.id}`,
          body: `⚠️ O post do ${group.name} marcado para ${spDayLabel(spDayKey(post.scheduledAt))} às ${spTimeLabel(post.scheduledAt)} não saiu: ${why}. Reagende pelo painel quando quiser.`,
        },
      });
    }
    return { skipped: reason };
  };

  const policy = await loadGroupPolicy(db);
  if (!policy.groupsEnabled) return skip("provador_desligado");
  if (!(await isWaEnabled(db))) return skip("desabilitado");
  if (!group.isActive) return skip("sala_inativa");
  if (isPaused(group, now)) return skip("sala_pausada");
  // A hora do ritual importa: post que a fila só alcança horas depois, ou
  // depois da janela (mais a folga), não sai — nunca "amanhã às 9h" (seria
  // outro dia, talvez domingo, talvez em cima de outro post).
  if (post.scheduledAt && isPostTooLate(post.scheduledAt, now)) return skip("atrasado");
  if (!canPublishNow(now, policy.cadence)) return skip("fora_da_janela");

  let providerMessageId: string;
  if (post.kind === "enquete" && post.pollOptions && post.pollOptions.length >= 2) {
    ({ providerMessageId } = await provider.sendPoll({
      toGroupId: group.providerGroupId,
      question: post.body,
      options: post.pollOptions,
      maxOptions: post.pollMaxOptions ?? 1,
    }));
  } else if (post.imageUrl) {
    ({ providerMessageId } = await provider.sendImage({ toE164: group.providerGroupId, imageUrl: post.imageUrl, caption: post.body }));
  } else {
    ({ providerMessageId } = await provider.sendText({ toE164: group.providerGroupId, body: post.body }));
  }

  await db.transaction(async (tx) => {
    await tx
      .update(waGroupPosts)
      .set({ status: "sent", sentAt: now, providerMessageId, updatedAt: now })
      .where(eq(waGroupPosts.id, post.id));
    if (post.kind === "enquete") {
      await enqueueOutboxEvent(
        tx,
        {
          eventType: "wa.group_poll_close",
          dedupeKey: `wa.group_poll_close:${post.id}`,
          aggregateType: "wa_group_post",
          aggregateId: post.id,
          payload: { postId: post.id },
          nextAttemptAt: new Date(now.getTime() + POLL_CLOSE_AFTER_HOURS * 3_600_000),
        },
        { kick: false },
      );
    }
  });
  return { sent: true, providerMessageId };
}

// ---------------------------------------------------------------------------
// closeGroupPoll — handler de wa.group_poll_close (e botão do painel)
// ---------------------------------------------------------------------------

export type CloseGroupPollResult =
  | { closed: true; winner: string | null; voters: number; announced: boolean }
  | { skipped: "inexistente" | "nao_enquete" | "nao_enviada" | "ja_apurada" | "fora_da_janela" };

/**
 * Apura os votos da enquete e anuncia o resultado no grupo, citando a
 * enquete — é a segunda metade do mesmo ritual, não um post novo (não conta
 * na cadência). Sem voto nenhum, apura em silêncio.
 */
export async function closeGroupPoll(db: DbOrTx, provider: MessagingProvider, input: { postId: string; now?: Date }): Promise<CloseGroupPollResult> {
  const now = input.now ?? new Date();
  const [row] = await db
    .select({ post: waGroupPosts, group: waGroups })
    .from(waGroupPosts)
    .innerJoin(waGroups, eq(waGroups.id, waGroupPosts.groupId))
    .where(eq(waGroupPosts.id, input.postId))
    .limit(1);
  if (!row) return { skipped: "inexistente" };
  const { post, group } = row;
  if (post.kind !== "enquete" || !post.pollOptions) return { skipped: "nao_enquete" };
  if (post.status !== "sent" || !post.providerMessageId) return { skipped: "nao_enviada" };
  if (post.pollClosedAt) return { skipped: "ja_apurada" };

  const policy = await loadGroupPolicy(db);
  // O resultado não é post (não conta na cadência), mas também não sai de
  // madrugada nem no domingo: adia para o próximo instante publicável.
  if (!canPublishNow(now, policy.cadence)) {
    await enqueueOutboxEvent(db, {
      eventType: "wa.group_poll_close",
      dedupeKey: `wa.group_poll_close:${post.id}:${spDayKey(now)}`,
      aggregateType: "wa_group_post",
      aggregateId: post.id,
      payload: { postId: post.id },
      nextAttemptAt: nextPublishableAt(now, policy.cadence),
    });
    return { skipped: "fora_da_janela" };
  }

  const votes = await db
    .select({ value: waGroupSignals.value })
    .from(waGroupSignals)
    .where(and(eq(waGroupSignals.kind, "poll_vote"), eq(waGroupSignals.referencedMessageId, post.providerMessageId)));
  const { tally, winner, voters } = tallyPoll(
    post.pollOptions,
    votes.map((vote) => decodePollVote(vote.value)),
  );

  let resultMessageId: string | null = null;
  const canAnnounce = winner !== null && policy.groupsEnabled && group.isActive && !isPaused(group, now) && (await isWaEnabled(db));
  if (canAnnounce) {
    const winning = tally.find((entry) => entry.option === winner);
    const body = renderPollResultPost({ winner, winnerVotes: winning?.votes ?? 0, voters });
    ({ providerMessageId: resultMessageId } = await provider.sendText({
      toE164: group.providerGroupId,
      body,
      quotedProviderMessageId: post.providerMessageId,
    }));
  }
  await db
    .update(waGroupPosts)
    .set({ pollClosedAt: now, pollResult: { tally, winner, voters, resultMessageId }, updatedAt: now })
    .where(eq(waGroupPosts.id, post.id));
  return { closed: true, winner, voters, announced: resultMessageId !== null };
}

// ---------------------------------------------------------------------------
// Sinais — o que o webhook manda quando é grupo
// ---------------------------------------------------------------------------

export type RecordGroupSignalResult =
  | { recorded: true; kind: GroupSignal["kind"]; groupId: string; postId: string | null; signalId: string }
  | { ignored: "provador_desligado" | "sala_desconhecida" | "sala_inativa" | "nao_e_sinal" };

/**
 * Grava um sinal do grupo. Voto/reação: o último vale (upsert por mensagem
 * referida + pessoa + tipo); menção/mensagem: o evento é único (replay não
 * duplica). Liga o sinal à cliente pelo telefone quando existe.
 */
export async function recordGroupSignal(db: DbOrTx, signal: GroupSignal, opts: { now?: Date } = {}): Promise<RecordGroupSignalResult> {
  const now = opts.now ?? new Date();
  const [group] = await db
    .select({ id: waGroups.id, isActive: waGroups.isActive })
    .from(waGroups)
    .where(eq(waGroups.providerGroupId, signal.groupId))
    .limit(1);
  if (!group) return { ignored: "sala_desconhecida" };
  if (!group.isActive) return { ignored: "sala_inativa" };

  const [post] = signal.referencedMessageId
    ? await db
        .select({ id: waGroupPosts.id })
        .from(waGroupPosts)
        .where(and(eq(waGroupPosts.groupId, group.id), eq(waGroupPosts.providerMessageId, signal.referencedMessageId)))
        .limit(1)
    : [];
  const [customer] = signal.participant.startsWith("+")
    ? await db
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.phoneE164, signal.participant), isNull(customers.deletedAt)))
        .limit(1)
    : [];

  const values = {
    groupId: group.id,
    postId: post?.id ?? null,
    participantPhone: signal.participant,
    customerId: customer?.id ?? null,
    kind: signal.kind,
    value: signal.value,
    providerMessageId: signal.providerMessageId,
    referencedMessageId: signal.referencedMessageId,
    createdAt: now,
    updatedAt: now,
  };
  let signalId: string | undefined;
  if (signal.kind === "poll_vote" || signal.kind === "reaction") {
    const [row] = await db
      .insert(waGroupSignals)
      .values(values)
      .onConflictDoUpdate({
        target: [waGroupSignals.referencedMessageId, waGroupSignals.participantPhone, waGroupSignals.kind],
        targetWhere: sql`${waGroupSignals.kind} IN ('poll_vote', 'reaction')`,
        set: { value: signal.value, providerMessageId: signal.providerMessageId, postId: post?.id ?? null, updatedAt: now },
      })
      .returning({ id: waGroupSignals.id });
    signalId = row?.id;
  } else {
    const [row] = await db
      .insert(waGroupSignals)
      .values(values)
      .onConflictDoNothing({
        target: [waGroupSignals.providerMessageId, waGroupSignals.kind],
        where: sql`${waGroupSignals.kind} IN ('mention', 'message')`,
      })
      .returning({ id: waGroupSignals.id });
    if (!row) {
      const [existing] = await db
        .select({ id: waGroupSignals.id })
        .from(waGroupSignals)
        .where(and(eq(waGroupSignals.providerMessageId, signal.providerMessageId), eq(waGroupSignals.kind, signal.kind)))
        .limit(1);
      signalId = existing?.id;
    } else {
      signalId = row.id;
    }
  }
  return { recorded: true, kind: signal.kind, groupId: group.id, postId: post?.id ?? null, signalId: signalId ?? "" };
}

/** O que o webhook precisa entregar de uma mensagem de grupo (já validado por Zod lá). */
export type GroupInboundBody = {
  messageId: string;
  phone: string;
  participantPhone?: string | null;
  participantLid?: string | null;
  fromMe?: boolean | null;
  text?: string | null;
  pollVote?: { pollMessageId?: string | null; options?: { name?: string | null }[] | null } | null;
  reaction?: { value?: string | null; reactionBy?: string | null; referencedMessage?: { messageId?: string | null } | null } | null;
};

/**
 * Entrada de grupo pelo webhook: classifica (core) e grava. Com o Provador
 * desligado nada é lido — nem para contar.
 */
export async function processGroupInbound(db: DbOrTx, body: GroupInboundBody, opts: { now?: Date } = {}): Promise<RecordGroupSignalResult> {
  const policy = await loadGroupPolicy(db);
  if (!policy.groupsEnabled) return { ignored: "provador_desligado" };
  const map = await getSettingsMap(db, ["bot_seller_name", "store_whatsapp"]);
  const sellerName = typeof map["bot_seller_name"] === "string" && map["bot_seller_name"].trim() ? map["bot_seller_name"] : "Lia";
  const storePhoneDigits = typeof map["store_whatsapp"] === "string" ? map["store_whatsapp"].replace(/\D/g, "") : null;
  const signal = parseGroupInbound(
    { ...body, chatId: body.phone },
    { sellerName, storePhoneDigits },
  );
  if (!signal) return { ignored: "nao_e_sinal" };
  return recordGroupSignal(db, signal, opts);
}

// ---------------------------------------------------------------------------
// Resultado por post (reações, votos, toques → conversas → pedidos)
// ---------------------------------------------------------------------------

export type GroupPostStats = {
  reactions: number;
  votes: number;
  mentions: number;
  taps: number;
  conversations: number;
  orders: number;
};

export async function getGroupPostStats(db: DbOrTx, postId: string): Promise<GroupPostStats> {
  const [post] = await db
    .select({ providerMessageId: waGroupPosts.providerMessageId, slug: campaignLinks.slug })
    .from(waGroupPosts)
    .leftJoin(campaignLinks, eq(campaignLinks.id, waGroupPosts.campaignLinkId))
    .where(eq(waGroupPosts.id, postId))
    .limit(1);
  const empty: GroupPostStats = { reactions: 0, votes: 0, mentions: 0, taps: 0, conversations: 0, orders: 0 };
  if (!post) return empty;
  const [signals] = await db
    .select({
      reactions: sql<number>`count(*) filter (where ${waGroupSignals.kind} = 'reaction' and ${waGroupSignals.value} <> '')::int`,
      votes: sql<number>`count(*) filter (where ${waGroupSignals.kind} = 'poll_vote' and ${waGroupSignals.value} <> '')::int`,
      mentions: sql<number>`count(*) filter (where ${waGroupSignals.kind} = 'mention')::int`,
    })
    .from(waGroupSignals)
    .where(eq(waGroupSignals.postId, postId));
  const [funnel] =
    post.slug && isProvadorCampaign(post.slug)
      ? await db
          .select({
            taps: sql<number>`count(*)::int`,
            conversations: sql<number>`count(*) filter (where ${siteCarts.consumedAt} is not null)::int`,
            orders: sql<number>`count(*) filter (where ${siteCarts.orderId} is not null)::int`,
          })
          .from(siteCarts)
          .where(and(eq(siteCarts.source, "campaign"), eq(siteCarts.campaignSlug, post.slug)))
      : [];
  return {
    reactions: Number(signals?.reactions ?? 0),
    votes: Number(signals?.votes ?? 0),
    mentions: Number(signals?.mentions ?? 0),
    taps: Number(funnel?.taps ?? 0),
    conversations: Number(funnel?.conversations ?? 0),
    orders: Number(funnel?.orders ?? 0),
  };
}

/** "10:00" do horário marcado, para o painel. */
export function postTimeLabel(post: { scheduledAt: Date | null; sentAt: Date | null }): string {
  const when = post.sentAt ?? post.scheduledAt;
  return when ? spTimeLabel(when) : "—";
}
