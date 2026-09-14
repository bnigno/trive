// Cartela de estilo: uma por telefone (enquanto não "esquecida"), com merge
// do que já se sabia, vínculo ao cadastro quando existe, consentimento que
// nunca rebaixa e "esquecer" que zera tudo. A edição para a cliente vem do
// core (buildEditionForProfile) sobre os fatos vendáveis do catálogo.
import { randomUUID } from "node:crypto";

import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";

import { buildEditionForProfile, type EditionPick } from "@/core/style/edition";
import {
  EMPTY_PROFILE,
  isProfileEmpty,
  mergeStyleProfile,
  paletteName,
  styleProfilePatchSchema,
  styleProfileSchema,
  type StyleProfile,
} from "@/core/style/profile";
import { BODY_KEYS, bodyMeasurementsSchema, type BodyMeasurements } from "@/core/style/fit";
import { auditLog, customerProfiles, customers } from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { revokeCustomerLooksByPhone } from "@/services/customer-looks";
import { listPublicVariantFacts, type PublicProductListItem } from "@/services/store-catalog";

const E164 = /^\+[1-9]\d{7,14}$/;

export interface StyleProfileView {
  id: string;
  phoneE164: string;
  customerId: string | null;
  siteToken: string;
  profile: StyleProfile;
  paletteName: string;
  source: string;
  consentAt: Date | null;
  updatedAt: Date;
  /** Só o fato: as medidas em si saem por getBodyMeasurements (nunca no histórico da Lia). */
  hasBodyMeasurements: boolean;
  bodyMeasuredAt: Date | null;
}

function toView(row: {
  id: string;
  phoneE164: string;
  customerId: string | null;
  siteToken: string;
  profile: unknown;
  paletteName: string | null;
  source: string;
  consentAt: Date | null;
  updatedAt: Date;
  bodyMeasurements?: unknown;
  bodyMeasuredAt?: Date | null;
}): StyleProfileView {
  const parsed = styleProfileSchema.safeParse(row.profile ?? {});
  const profile = parsed.success ? parsed.data : EMPTY_PROFILE;
  return {
    id: row.id,
    phoneE164: row.phoneE164,
    customerId: row.customerId,
    siteToken: row.siteToken,
    profile,
    paletteName: row.paletteName ?? paletteName(profile),
    source: row.source,
    consentAt: row.consentAt,
    updatedAt: row.updatedAt,
    hasBodyMeasurements: bodyMeasurementsSchema.safeParse(row.bodyMeasurements ?? {}).success,
    bodyMeasuredAt: row.bodyMeasuredAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// Medidas do corpo — coluna própria, nunca no perfil nem no histórico da Lia
// ---------------------------------------------------------------------------

/** Quem é: o token do navegador (site) ou o telefone (Lia). */
type ProfileRef = { siteToken?: string; phoneE164?: string };

function profileCondition(ref: ProfileRef) {
  if (ref.siteToken && z.uuid().safeParse(ref.siteToken).success) {
    return and(eq(customerProfiles.siteToken, ref.siteToken), isNull(customerProfiles.forgottenAt));
  }
  if (ref.phoneE164) return activeByPhone(ref.phoneE164);
  return null;
}

/**
 * Grava (ou troca) as medidas da cartela. Sem cartela ativa, não há onde
 * guardar. Pelo SITE, trocar medidas que já existem exige o `bodyToken`
 * (a credencial que saiu para o navegador que gravou): o token da cartela
 * sai para quem digita o telefone no quiz e não prova posse. Pelo telefone
 * (a Lia) e pelo painel a prova de posse é a própria conversa/login.
 */
export async function saveBodyMeasurements(
  db: DbOrTx,
  input: ProfileRef & { body: BodyMeasurements; bodyToken?: string | null; userId?: string; now?: Date },
): Promise<{ saved: boolean; bodyToken: string | null; reason?: "sem_cartela" | "sem_credencial" }> {
  const condition = profileCondition(input);
  if (!condition) return { saved: false, bodyToken: null, reason: "sem_cartela" };
  const body = bodyMeasurementsSchema.parse(input.body);
  const now = input.now ?? new Date();
  const [current] = await db.select({ id: customerProfiles.id, bodyToken: customerProfiles.bodyToken, hasBody: customerProfiles.bodyMeasurements }).from(customerProfiles).where(condition).limit(1);
  if (!current) return { saved: false, bodyToken: null, reason: "sem_cartela" };
  const viaSite = input.siteToken !== undefined && input.phoneE164 === undefined && !input.userId;
  if (viaSite && current.hasBody !== null && (!input.bodyToken || input.bodyToken !== current.bodyToken)) {
    return { saved: false, bodyToken: null, reason: "sem_credencial" };
  }
  // A credencial só sobrevive quando a gravação foi provada por ela (site com
  // o token certo). Pela Lia ou pelo painel, gira: um navegador que tivesse
  // semeado medidas com o telefone de outra pessoa perde o acesso ao que ela
  // contou de verdade.
  const bodyToken = viaSite && input.bodyToken !== undefined && input.bodyToken === current.bodyToken ? current.bodyToken : randomUUID();
  const updated = await db
    .update(customerProfiles)
    .set({ bodyMeasurements: body, bodyMeasuredAt: now, bodyToken, updatedAt: now })
    .where(eq(customerProfiles.id, current.id))
    .returning({ id: customerProfiles.id });
  if (updated.length === 0) return { saved: false, bodyToken: null, reason: "sem_cartela" };
  // A trilha diz QUE mudou, nunca os números.
  await db.insert(auditLog).values({
    actorType: input.userId ? "user" : "customer",
    actorId: input.userId ?? null,
    action: "style.body_measurements_save",
    entityType: "customer_profile",
    entityId: updated[0].id,
    after: { measuredAt: now.toISOString(), keys: BODY_KEYS.filter((key) => body[key] !== undefined) },
  });
  return { saved: true, bodyToken };
}

/**
 * Lê as medidas. Pelo site exige o `bodyToken` (sem ele, para aquele
 * navegador é como se não houvesse medidas); pelo telefone/painel, não.
 */
export async function getBodyMeasurements(db: DbOrTx, ref: ProfileRef & { bodyToken?: string | null }): Promise<{ body: BodyMeasurements; measuredAt: Date | null } | null> {
  const condition = profileCondition(ref);
  if (!condition) return null;
  const [row] = await db.select({ body: customerProfiles.bodyMeasurements, measuredAt: customerProfiles.bodyMeasuredAt, bodyToken: customerProfiles.bodyToken }).from(customerProfiles).where(condition).limit(1);
  const parsed = bodyMeasurementsSchema.safeParse(row?.body ?? {});
  if (!row || !parsed.success) return null;
  const viaSite = ref.siteToken !== undefined && ref.phoneE164 === undefined;
  if (viaSite && (!ref.bodyToken || ref.bodyToken !== row.bodyToken)) return null;
  return { body: parsed.data, measuredAt: row.measuredAt };
}

/** "Apagar minhas medidas": só as medidas; a cartela fica. Pelo site exige o `bodyToken`. */
export async function forgetBodyMeasurements(db: DbOrTx, ref: ProfileRef & { bodyToken?: string | null; userId?: string }): Promise<{ forgotten: boolean }> {
  const condition = profileCondition(ref);
  if (!condition) return { forgotten: false };
  const viaSite = ref.siteToken !== undefined && ref.phoneE164 === undefined && !ref.userId;
  const now = new Date();
  const updated = await db
    .update(customerProfiles)
    .set({ bodyMeasurements: null, bodyMeasuredAt: null, bodyToken: null, updatedAt: now })
    .where(and(condition, isNotNull(customerProfiles.bodyMeasurements), ...(viaSite ? [eq(customerProfiles.bodyToken, ref.bodyToken ?? "00000000-0000-0000-0000-000000000000")] : [])))
    .returning({ id: customerProfiles.id });
  if (updated.length === 0) return { forgotten: false };
  await db.insert(auditLog).values({
    actorType: ref.userId ? "user" : "customer",
    actorId: ref.userId ?? null,
    action: "style.body_measurements_forget",
    entityType: "customer_profile",
    entityId: updated[0].id,
    after: { forgottenAt: now.toISOString() },
  });
  return { forgotten: true };
}

const activeByPhone = (phoneE164: string) =>
  and(eq(customerProfiles.phoneE164, phoneE164), isNull(customerProfiles.forgottenAt));

// ---------------------------------------------------------------------------
// saveStyleProfile
// ---------------------------------------------------------------------------

const saveSchema = z.object({
  phoneE164: z.string().regex(E164, "Telefone deve estar em E.164."),
  patch: styleProfilePatchSchema,
  source: z.enum(["quiz", "lia", "admin", "checkout"]),
  /** true = a cliente consentiu agora (quiz/checkout); nunca rebaixa um consentimento anterior. */
  consent: z.boolean().default(false),
  customerId: z.uuid().nullable().optional(),
  userId: z.uuid().optional(),
});

export type SaveStyleProfileInput = z.input<typeof saveSchema>;

export async function saveStyleProfile(db: DbOrTx, input: SaveStyleProfileInput): Promise<StyleProfileView> {
  const parsed = saveSchema.parse(input);
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(customerProfiles)
      .where(activeByPhone(parsed.phoneE164))
      .for("update")
      .limit(1);

    let customerId = parsed.customerId ?? existing?.customerId ?? null;
    if (!customerId) {
      const [customer] = await tx
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.phoneE164, parsed.phoneE164), isNull(customers.deletedAt)))
        .limit(1);
      customerId = customer?.id ?? null;
    }

    const current = existing ? toView(existing).profile : EMPTY_PROFILE;
    const merged = mergeStyleProfile(current, parsed.patch);
    const palette = paletteName(merged);
    const now = new Date();
    const consentAt = existing?.consentAt ?? (parsed.consent ? now : null);

    let row;
    if (existing) {
      [row] = await tx
        .update(customerProfiles)
        .set({ profile: merged, paletteName: palette, customerId, consentAt, source: parsed.source, updatedAt: now })
        .where(eq(customerProfiles.id, existing.id))
        .returning();
    } else {
      [row] = await tx
        .insert(customerProfiles)
        .values({ phoneE164: parsed.phoneE164, customerId, profile: merged, paletteName: palette, source: parsed.source, consentAt })
        .returning();
    }

    await tx.insert(auditLog).values({
      actorType: parsed.userId ? "user" : parsed.source === "lia" ? "system" : "customer",
      actorId: parsed.userId ?? null,
      action: existing ? "style.profile_update" : "style.profile_create",
      entityType: "customer_profile",
      entityId: row.id,
      before: existing ? { profile: current } : null,
      after: { profile: merged, paletteName: palette, source: parsed.source, consent: consentAt !== null },
    });
    return toView(row);
  });
}

// ---------------------------------------------------------------------------
// Consultas e esquecimento
// ---------------------------------------------------------------------------

export async function getStyleProfileByPhone(db: DbOrTx, phoneE164: string): Promise<StyleProfileView | null> {
  const [row] = await db.select().from(customerProfiles).where(activeByPhone(phoneE164)).limit(1);
  return row ? toView(row) : null;
}

export async function getStyleProfileByToken(db: DbOrTx, siteToken: string): Promise<StyleProfileView | null> {
  if (!z.uuid().safeParse(siteToken).success) return null;
  const [row] = await db
    .select()
    .from(customerProfiles)
    .where(and(eq(customerProfiles.siteToken, siteToken), isNull(customerProfiles.forgottenAt)))
    .limit(1);
  return row ? toView(row) : null;
}

export async function getStyleProfileByCustomer(
  db: DbOrTx,
  input: { customerId: string; phoneE164?: string | null },
): Promise<StyleProfileView | null> {
  const [row] = await db
    .select()
    .from(customerProfiles)
    .where(and(eq(customerProfiles.customerId, input.customerId), isNull(customerProfiles.forgottenAt)))
    .limit(1);
  if (row) return toView(row);
  return input.phoneE164 ? getStyleProfileByPhone(db, input.phoneE164) : null;
}

/** Vincula a cartela do navegador (token) ao cadastro, se ainda não estiver. */
export async function linkStyleProfileToCustomer(
  db: DbOrTx,
  input: { siteToken: string; customerId: string },
): Promise<boolean> {
  if (!z.uuid().safeParse(input.siteToken).success) return false;
  const updated = await db
    .update(customerProfiles)
    .set({ customerId: input.customerId, updatedAt: new Date() })
    .where(and(eq(customerProfiles.siteToken, input.siteToken), isNull(customerProfiles.forgottenAt)))
    .returning({ id: customerProfiles.id });
  return updated.length > 0;
}

/** "Esquecer minha cartela": zera os campos e carimba forgotten_at (LGPD). */
export async function forgetStyleProfile(
  db: DbOrTx,
  input: { siteToken?: string; profileId?: string; userId?: string },
): Promise<{ forgotten: boolean }> {
  const condition = input.profileId
    ? eq(customerProfiles.id, input.profileId)
    : input.siteToken && z.uuid().safeParse(input.siteToken).success
      ? eq(customerProfiles.siteToken, input.siteToken)
      : null;
  if (!condition) return { forgotten: false };
  const now = new Date();
  const updated = await db
    .update(customerProfiles)
    .set({ profile: {}, paletteName: null, bodyMeasurements: null, bodyMeasuredAt: null, bodyToken: null, forgottenAt: now, updatedAt: now })
    .where(and(condition, isNull(customerProfiles.forgottenAt)))
    .returning({ id: customerProfiles.id, phoneE164: customerProfiles.phoneE164, customerId: customerProfiles.customerId });
  if (updated.length === 0) return { forgotten: false };
  // "Esquecer tudo dela" pelo painel também retira as fotos do "Quem já
  // vestiu" (vitrine e bucket). Pelo site NÃO: o token da cartela sai para
  // quem digitar o telefone no quiz, e a retirada de foto precisa de prova de
  // posse — a cliente retira pela Lia (o próprio WhatsApp dela) e a dona pelo painel.
  if (input.userId) {
    await revokeCustomerLooksByPhone(db, { phoneE164: updated[0].phoneE164, customerId: updated[0].customerId, source: "forget", now });
  }
  await db.insert(auditLog).values({
    actorType: input.userId ? "user" : "customer",
    actorId: input.userId ?? null,
    action: "style.profile_forget",
    entityType: "customer_profile",
    entityId: updated[0].id,
    after: { forgottenAt: now.toISOString() },
  });
  return { forgotten: true };
}

// ---------------------------------------------------------------------------
// curateEditionForProfile — "A edição para você"
// ---------------------------------------------------------------------------

export interface CuratedEditionItem {
  product: PublicProductListItem;
  reasons: string[];
}

export async function curateEditionForProfile(
  db: DbOrTx,
  profile: StyleProfile,
  opts: { limit?: number } = {},
): Promise<CuratedEditionItem[]> {
  if (isProfileEmpty(profile)) return [];
  const facts = await listPublicVariantFacts(db);
  const picks: EditionPick[] = buildEditionForProfile(
    profile,
    facts.map((fact) => ({
      id: fact.product.id,
      slug: fact.product.slug,
      name: fact.product.name,
      categoryName: fact.product.categoryName,
      priceFromCents: fact.product.priceFromCents,
      imagePath: fact.product.imagePath,
      sizesAvailable: fact.sizesAvailable,
      colorsAvailable: fact.colorsAvailable,
    })),
    { limit: opts.limit ?? 3 },
  );
  const byId = new Map(facts.map((fact) => [fact.product.id, fact.product]));
  return picks.flatMap((pick) => {
    const product = byId.get(pick.candidate.id);
    return product ? [{ product, reasons: pick.reasons }] : [];
  });
}
