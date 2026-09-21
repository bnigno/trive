// Edições de Belém: a dona cria a "Edição Círio" (frase, parágrafo,
// bairros, capa, vigência) e escolhe as peças; a vitrine mostra a vigente
// na home, o chip na coleção e /belem/[slug]. A regra de vigência é pura
// (core/city-editions). NÃO confundir com o cartão da caixa (core/edition).
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import sharp from "sharp";
import { z } from "zod";

import type { FileStorage } from "@/adapters/storage";
import {
  daysUntilEdition,
  editionKind,
  editionPeriodLabel,
  isEditionCurrent,
  isEditionPast,
  pickCurrentEdition,
  type EditionKind,
  type EditionRule,
} from "@/core/city-editions";
import { auditLog, cityEditionProducts, cityEditions, products } from "@/db/schema";
import { slugify } from "@/lib/slug";
import type { DbOrTx } from "@/queue/enqueue";
import { ServiceError } from "@/services/settings";

export { ServiceError };

export const CITY_EDITION_MAX_PRODUCTS = 40;
const COVER_MAX_EDGE = 1600;
const COVER_JPEG_QUALITY = 84;
export const COVER_MAX_BYTES = 8 * 1024 * 1024;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface CityEdition extends EditionRule {
  id: string;
  name: string;
  slug: string;
  openingLine: string | null;
  body: string | null;
  districts: string | null;
  coverPath: string | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CityEditionProduct {
  id: string;
  name: string;
  slug: string;
  status: string;
  sortOrder: number;
  imagePath: string | null;
}

function toEdition(row: typeof cityEditions.$inferSelect): CityEdition {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    openingLine: row.openingLine,
    body: row.body,
    districts: row.districts,
    coverPath: row.coverPath,
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    hourStart: row.hourStart,
    hourEnd: row.hourEnd,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Leitura (painel e vitrine)
// ---------------------------------------------------------------------------

export async function listCityEditions(db: DbOrTx): Promise<(CityEdition & { productCount: number })[]> {
  const rows = await db
    .select({
      edition: cityEditions,
      productCount: sql<string>`(select count(*) from city_edition_products cep where cep.city_edition_id = ${cityEditions.id})`,
    })
    .from(cityEditions)
    .orderBy(asc(cityEditions.sortOrder), asc(cityEditions.name));
  return rows.map((row) => ({ ...toEdition(row.edition), productCount: Number(row.productCount) }));
}

/** Peças que a dona pode colocar numa edição (tudo que não foi arquivado/apagado). */
export async function listEditionProductChoices(db: DbOrTx): Promise<{ id: string; name: string; status: string }[]> {
  return db
    .select({ id: products.id, name: products.name, status: products.status })
    .from(products)
    .where(and(isNull(products.deletedAt), ne(products.status, "archived")))
    .orderBy(asc(products.name));
}

export async function getCityEdition(db: DbOrTx, id: string): Promise<(CityEdition & { products: CityEditionProduct[] }) | null> {
  const [row] = await db.select().from(cityEditions).where(eq(cityEditions.id, id)).limit(1);
  if (!row) return null;
  return { ...toEdition(row), products: await loadEditionProducts(db, row.id) };
}

async function loadEditionProducts(db: DbOrTx, editionId: string): Promise<CityEditionProduct[]> {
  const rows = await db
    .select({
      id: products.id,
      name: products.name,
      slug: products.slug,
      status: products.status,
      sortOrder: cityEditionProducts.sortOrder,
      // Só foto real: a capa da edição é da vitrine, que decide sozinha
      // (ai_photos_in_store) o que mostra da foto no corpo.
      imagePath: sql<string | null>`(
        select pi.storage_path from product_images pi where pi.product_id = ${products.id} and pi.origin = 'upload'
        order by pi.sort_order asc, pi.created_at asc limit 1
      )`,
    })
    .from(cityEditionProducts)
    .innerJoin(products, eq(products.id, cityEditionProducts.productId))
    .where(eq(cityEditionProducts.cityEditionId, editionId))
    .orderBy(asc(cityEditionProducts.sortOrder), asc(products.name));
  return rows;
}

/** O que a vitrine mostra de uma edição (sem dados do painel). */
export interface PublicCityEdition {
  id: string;
  name: string;
  slug: string;
  openingLine: string | null;
  bodyParagraphs: string[];
  districts: string[];
  coverPath: string | null;
  kind: EditionKind;
  periodLabel: string;
  /** Está no ar agora (relógio de SP). */
  isCurrent: boolean;
  /** Dias até começar (0 = já/hoje; null = sem data ou passou). */
  daysUntil: number | null;
}

function toPublic(edition: CityEdition, now: Date): PublicCityEdition {
  return {
    id: edition.id,
    name: edition.name,
    slug: edition.slug,
    openingLine: edition.openingLine,
    bodyParagraphs: (edition.body ?? "")
      .split(/\n+/)
      .map((p) => p.trim())
      .filter(Boolean),
    districts: (edition.districts ?? "")
      .split(/[\n,;]+/)
      .map((d) => d.trim())
      .filter(Boolean),
    coverPath: edition.coverPath,
    kind: editionKind(edition),
    periodLabel: editionPeriodLabel(edition),
    isCurrent: isEditionCurrent(edition, now),
    daysUntil: daysUntilEdition(edition, now),
  };
}

/**
 * Edições ativas para a vitrine, a vigente primeiro (hora > período >
 * sempre), depois as que ainda vêm e as permanentes; edições já encerradas
 * ficam de fora. `now` injetável.
 */
export async function listPublicCityEditions(db: DbOrTx, input: { now?: Date } = {}): Promise<PublicCityEdition[]> {
  const now = input.now ?? new Date();
  const rows = (await db.select().from(cityEditions).where(eq(cityEditions.isActive, true)).orderBy(asc(cityEditions.sortOrder), asc(cityEditions.name))).map(toEdition);
  const current = pickCurrentEdition(rows, now);
  const visible = rows.filter((e) => !isEditionPast(e, now));
  const ordered = [...(current ? [current] : []), ...visible.filter((e) => e.id !== current?.id)];
  return ordered.map((e) => toPublic(e, now));
}

/** A edição que manda agora, ou null. */
export async function getCurrentCityEdition(db: DbOrTx, input: { now?: Date } = {}): Promise<PublicCityEdition | null> {
  const list = await listPublicCityEditions(db, input);
  return list.find((e) => e.isCurrent) ?? null;
}

/** A página pública da edição: ativa e não encerrada (encerrada = 404, como as demais listas). */
export async function getPublicCityEditionBySlug(db: DbOrTx, slug: string, input: { now?: Date } = {}): Promise<PublicCityEdition | null> {
  const now = input.now ?? new Date();
  const [row] = await db.select().from(cityEditions).where(and(eq(cityEditions.slug, slug), eq(cityEditions.isActive, true))).limit(1);
  if (!row) return null;
  const edition = toEdition(row);
  return isEditionPast(edition, now) ? null : toPublic(edition, now);
}

/** Edição na planta da loja da Lia: nome, slug, peças vendáveis e vigência. */
export interface StoreMapEdition {
  name: string;
  slug: string;
  productCount: number;
  current: boolean;
  daysUntil: number | null;
  kind: EditionKind;
}

/**
 * As edições ativas e não encerradas, com a contagem de peças VENDÁVEIS
 * (ativa, com preço e visível) — o que a Lia pode mostrar de verdade.
 */
export async function listStoreMapEditions(db: DbOrTx, input: { now?: Date } = {}): Promise<StoreMapEdition[]> {
  const list = await listPublicCityEditions(db, input);
  if (list.length === 0) return [];
  const counts = await db
    .select({
      editionId: cityEditionProducts.cityEditionId,
      count: sql<string>`count(distinct ${products.id})`,
    })
    .from(cityEditionProducts)
    .innerJoin(products, eq(products.id, cityEditionProducts.productId))
    .where(
      and(
        inArray(cityEditionProducts.cityEditionId, list.map((e) => e.id)),
        eq(products.status, "active"),
        isNull(products.deletedAt),
        sql`(${products.visibleFrom} IS NULL OR ${products.visibleFrom} <= now())`,
        sql`exists (
          select 1 from product_variants pv join price_versions pr on pr.product_variant_id = pv.id
          where pv.product_id = ${products.id} and pv.deleted_at is null and pv.is_active = true and pr.status = 'active'
        )`,
      ),
    )
    .groupBy(cityEditionProducts.cityEditionId);
  const countById = new Map(counts.map((row) => [row.editionId, Number(row.count)]));
  // Sem peça vendável a Lia não tem o que mostrar: fica fora da planta.
  return list
    .map((e) => ({ name: e.name, slug: e.slug, productCount: countById.get(e.id) ?? 0, current: e.isCurrent, daysUntil: e.daysUntil, kind: e.kind }))
    .filter((e) => e.productCount > 0);
}

/** A edição que o "Bom dia" comenta: peças escolhidas e quantas ainda sem foto. */
export async function summarizeCityEditionsForDigest(
  db: DbOrTx,
  input: { now?: Date } = {},
): Promise<{ name: string; isCurrent: boolean; daysUntil: number | null; kind: EditionKind; hours: { start: number; end: number } | null; products: number; missingPhoto: number }[]> {
  const list = await listPublicCityEditions(db, input);
  const rules = await db.select({ id: cityEditions.id, hourStart: cityEditions.hourStart, hourEnd: cityEditions.hourEnd }).from(cityEditions).where(inArray(cityEditions.id, list.map((e) => e.id)));
  const hoursById = new Map(rules.map((r) => [r.id, r.hourStart !== null && r.hourEnd !== null ? { start: r.hourStart, end: r.hourEnd } : null]));
  const result = [];
  for (const edition of list) {
    // Peça arquivada não conta como escolhida (nem como "sem foto").
    const items = (await loadEditionProducts(db, edition.id)).filter((item) => item.status !== "archived");
    result.push({
      name: edition.name,
      isCurrent: edition.isCurrent,
      daysUntil: edition.daysUntil,
      kind: edition.kind,
      hours: hoursById.get(edition.id) ?? null,
      products: items.length,
      missingPhoto: items.filter((item) => item.imagePath === null).length,
    });
  }
  return result;
}

/** Nome ou slug (sem caixa) → slug de uma edição ativa e não encerrada; null se não existir. */
export async function resolveCityEditionSlug(db: DbOrTx, term: string, input: { now?: Date } = {}): Promise<{ slug: string; name: string } | null> {
  const list = await listPublicCityEditions(db, input);
  const STOP = new Set(["edicao", "edicoes", "de", "do", "da", "dos", "das", "a", "o", "as", "os", "para", "pro", "pra"]);
  // "edição do Círio" → "cirio"; "Círio de Nazaré" → "cirio nazare": compara o que sobra sem as palavras vazias.
  const core = (value: string) =>
    value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((word) => word && !STOP.has(word))
      .join(" ");
  const wanted = core(term);
  if (wanted.length < 3) return null;
  const found =
    list.find((e) => e.slug === term.trim().toLowerCase()) ??
    list.find((e) => core(e.name) === wanted) ??
    list.find((e) => core(e.name).includes(wanted)) ??
    list.find((e) => wanted.includes(core(e.name)) && core(e.name).length >= 3);
  return found ? { slug: found.slug, name: found.name } : null;
}

// ---------------------------------------------------------------------------
// Escrita (painel, só o dono)
// ---------------------------------------------------------------------------

const hour = z.number().int().min(0).max(24);

const fieldsSchema = z
  .object({
    name: z.string().trim().min(2, "Dê um nome à edição.").max(80),
    slug: z.string().trim().max(80).optional(),
    openingLine: z.string().trim().max(160).nullable().optional(),
    body: z.string().trim().max(4000).nullable().optional(),
    districts: z.string().trim().max(2000).nullable().optional(),
    startsOn: z.string().regex(DAY, "Data no formato AAAA-MM-DD.").nullable().optional(),
    endsOn: z.string().regex(DAY, "Data no formato AAAA-MM-DD.").nullable().optional(),
    hourStart: hour.nullable().optional(),
    hourEnd: hour.nullable().optional(),
    sortOrder: z.number().int().min(0).max(999).optional(),
  })
  .refine((f) => !(f.startsOn && f.endsOn) || f.startsOn <= f.endsOn, { message: "O fim da vigência tem de vir depois do começo.", path: ["endsOn"] })
  .refine((f) => (f.hourStart ?? null) === null || (f.hourEnd ?? null) !== null, { message: "Informe a hora final.", path: ["hourEnd"] })
  .refine((f) => (f.hourEnd ?? null) === null || (f.hourStart ?? null) !== null, { message: "Informe a hora inicial.", path: ["hourStart"] })
  .refine((f) => f.hourStart == null || f.hourEnd == null || f.hourStart < f.hourEnd, { message: "A hora final tem de ser depois da inicial.", path: ["hourEnd"] })
  .refine((f) => f.hourStart == null || f.hourStart <= 23, { message: "A hora inicial vai de 0 a 23.", path: ["hourStart"] })
  .refine((f) => f.hourEnd == null || f.hourEnd >= 1, { message: "A hora final vai de 1 a 24.", path: ["hourEnd"] });

const createSchema = z.object({ fields: fieldsSchema, isActive: z.boolean().default(false), userId: z.uuid() });
const updateSchema = z.object({ editionId: z.uuid(), fields: fieldsSchema, isActive: z.boolean().optional(), userId: z.uuid() });

export type CityEditionFields = z.input<typeof fieldsSchema>;

async function uniqueSlug(db: DbOrTx, wanted: string, ignoreId: string | null): Promise<string> {
  const base = slugify(wanted) || "edicao";
  let candidate = base;
  for (let i = 2; i < 50; i += 1) {
    const [clash] = await db.select({ id: cityEditions.id }).from(cityEditions).where(eq(cityEditions.slug, candidate)).limit(1);
    if (!clash || clash.id === ignoreId) return candidate;
    candidate = `${base}-${i}`;
  }
  throw new ServiceError("slug_indisponivel", "Não consegui um endereço livre para esta edição — mude o nome.");
}

export async function createCityEdition(db: DbOrTx, input: z.input<typeof createSchema>): Promise<{ editionId: string; slug: string }> {
  const { fields, isActive, userId } = createSchema.parse(input);
  return db.transaction(async (tx) => {
    const slug = await uniqueSlug(tx, fields.slug || fields.name, null);
    const [row] = await tx
      .insert(cityEditions)
      .values({
        name: fields.name,
        slug,
        isActive,
        openingLine: fields.openingLine || null,
        body: fields.body || null,
        districts: fields.districts || null,
        startsOn: fields.startsOn ?? null,
        endsOn: fields.endsOn ?? null,
        hourStart: fields.hourStart ?? null,
        hourEnd: fields.hourEnd ?? null,
        sortOrder: fields.sortOrder ?? 0,
        createdBy: userId,
      })
      .returning({ id: cityEditions.id });
    await tx.insert(auditLog).values({ actorType: "user", actorId: userId, action: "city_edition.create", entityType: "city_edition", entityId: row.id, after: { name: fields.name, slug } });
    return { editionId: row.id, slug };
  });
}

export async function updateCityEdition(db: DbOrTx, input: z.input<typeof updateSchema>): Promise<void> {
  const { editionId, fields, isActive, userId } = updateSchema.parse(input);
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(cityEditions).where(eq(cityEditions.id, editionId)).limit(1);
    if (!before) throw new ServiceError("edicao_inexistente", "Edição não encontrada.");
    const slug = await uniqueSlug(tx, fields.slug || before.slug, editionId);
    await tx
      .update(cityEditions)
      .set({
        name: fields.name,
        slug,
        openingLine: fields.openingLine || null,
        body: fields.body || null,
        districts: fields.districts || null,
        startsOn: fields.startsOn ?? null,
        endsOn: fields.endsOn ?? null,
        hourStart: fields.hourStart ?? null,
        hourEnd: fields.hourEnd ?? null,
        sortOrder: fields.sortOrder ?? before.sortOrder,
        ...(isActive !== undefined ? { isActive } : {}),
        updatedAt: new Date(),
      })
      .where(eq(cityEditions.id, editionId));
    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: userId,
      action: "city_edition.update",
      entityType: "city_edition",
      entityId: editionId,
      before: { name: before.name, slug: before.slug, isActive: before.isActive, startsOn: before.startsOn, endsOn: before.endsOn },
      after: { name: fields.name, slug, isActive: isActive ?? before.isActive, startsOn: fields.startsOn ?? null, endsOn: fields.endsOn ?? null },
    });
  });
}

/** Substitui as peças da edição (a ordem da lista vira sort_order). */
export async function setCityEditionProducts(db: DbOrTx, input: { editionId: string; productIds: string[]; userId: string }): Promise<void> {
  const productIds = [...new Set(input.productIds)];
  if (productIds.length > CITY_EDITION_MAX_PRODUCTS) {
    throw new ServiceError("edicao_muitas_pecas", `Uma edição leva no máximo ${CITY_EDITION_MAX_PRODUCTS} peças.`);
  }
  await db.transaction(async (tx) => {
    const [edition] = await tx.select({ id: cityEditions.id }).from(cityEditions).where(eq(cityEditions.id, input.editionId)).limit(1);
    if (!edition) throw new ServiceError("edicao_inexistente", "Edição não encontrada.");
    if (productIds.length > 0) {
      const found = await tx.select({ id: products.id }).from(products).where(inArray(products.id, productIds));
      if (found.length !== productIds.length) throw new ServiceError("peca_inexistente", "Uma das peças escolhidas não existe mais.");
    }
    await tx.delete(cityEditionProducts).where(eq(cityEditionProducts.cityEditionId, input.editionId));
    if (productIds.length > 0) {
      await tx.insert(cityEditionProducts).values(productIds.map((productId, index) => ({ cityEditionId: input.editionId, productId, sortOrder: index })));
    }
    await tx.update(cityEditions).set({ updatedAt: new Date() }).where(eq(cityEditions.id, input.editionId));
    await tx.insert(auditLog).values({ actorType: "user", actorId: input.userId, action: "city_edition.set_products", entityType: "city_edition", entityId: input.editionId, after: { productIds } });
  });
}

export function cityEditionCoverPath(editionId: string, at: Date): string {
  return `city-editions/${editionId}/cover-${at.getTime()}.jpg`;
}

/** Capa: reduzida no servidor (lado maior 1600 px, JPEG) e gravada no Storage público. */
export async function setCityEditionCover(
  db: DbOrTx,
  storage: FileStorage,
  input: { editionId: string; data: Uint8Array; userId: string; now?: Date },
): Promise<{ coverPath: string }> {
  if (input.data.byteLength > COVER_MAX_BYTES) throw new ServiceError("imagem_grande", "A capa passou de 8 MB.");
  const [edition] = await db.select({ id: cityEditions.id, coverPath: cityEditions.coverPath }).from(cityEditions).where(eq(cityEditions.id, input.editionId)).limit(1);
  if (!edition) throw new ServiceError("edicao_inexistente", "Edição não encontrada.");
  let jpeg: Buffer;
  try {
    jpeg = await sharp(Buffer.from(input.data))
      .rotate()
      .resize({ width: COVER_MAX_EDGE, height: COVER_MAX_EDGE, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: COVER_JPEG_QUALITY })
      .toBuffer();
  } catch {
    throw new ServiceError("imagem_invalida", "Não foi possível processar a capa. Escolha um JPG ou PNG.");
  }
  const coverPath = cityEditionCoverPath(edition.id, input.now ?? new Date());
  await storage.upload({ path: coverPath, data: jpeg, contentType: "image/jpeg" });
  await db.update(cityEditions).set({ coverPath, updatedAt: new Date() }).where(eq(cityEditions.id, edition.id));
  if (edition.coverPath && edition.coverPath !== coverPath) {
    await storage.remove(edition.coverPath).catch(() => undefined);
  }
  return { coverPath };
}
