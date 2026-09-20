// Catálogo PÚBLICO da loja (somente leitura) + cotação de frete.
// Fase 2: vitrine sem autenticação. Nada aqui muta estado — sem audit/outbox.
// Regra central: só é visível o que está ativo E tem preço ativo (price_versions
// status 'active'); preço exibido é sempre o do banco, nunca o do cliente.
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
  compareSizeLabels,
  parseMeasurements,
  type Measurements,
} from "@/core/catalog/measurements";
import { PIECE_TYPE_SLUGS, pieceTypePlural, type PieceType } from "@/core/catalog/piece-types";
import { z } from "zod";

import * as schema from "@/db/schema";
import {
  categories,
  priceVersions,
  productImages,
  products,
  productVariants,
  shippingRates,
  stockLevels,
} from "@/db/schema";
import {
  expandDeliveryOptions,
  sameDayPromise,
  type DeliveryOption,
  type DeliveryWindow,
  type SameDayPromise,
  type ShippingKind,
} from "@/core/shipping/delivery-windows";
import type { CorreiosQuoter } from "@/adapters/superfrete";
import { cepDigits } from "@/lib/cep";
import type { DbOrTx } from "@/queue/enqueue";
import { listStoreMapEditions, type StoreMapEdition } from "@/services/city-editions";
import { quoteCorreiosOptions } from "@/services/correios-quotes";
import { parseWindows } from "@/services/shipping";

/**
 * Base estrutural comum a Db (postgres.js), transações e o TestDb (PGlite),
 * mesmo padrão do src/services/catalog.ts. Injetado — nunca getDb() aqui.
 */
export type ServiceDb = PgDatabase<PgQueryResultHKT, typeof schema>;

// ---------------------------------------------------------------------------
// Erros de negócio
// ---------------------------------------------------------------------------

export class ServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Condições reutilizadas: "variante vendável" = ativa, não deletada e com
// preço ativo. Produto público = status 'active', não deletado, com ao menos
// uma variante vendável.
// ---------------------------------------------------------------------------

const sellableVariantJoin = () =>
  and(
    eq(productVariants.productId, products.id),
    eq(productVariants.isActive, true),
    isNull(productVariants.deletedAt),
  );

const activePriceJoin = () =>
  and(
    eq(priceVersions.productVariantId, productVariants.id),
    eq(priceVersions.status, "active"),
  );

/** Quem está olhando: convidada de lançamento enxerga a peça escondida. */
export interface CatalogViewer {
  customerId?: string | null;
  inviteToken?: string | null;
}

/**
 * Peça visível: sem visible_from, ou já passou, ou a viewer é convidada de
 * um lançamento (agendado/VIP) com a peça e a janela VIP já abriu.
 */
export function publiclyVisible(viewer?: CatalogViewer, now: Date = new Date()) {
  const base = or(isNull(products.visibleFrom), lte(products.visibleFrom, now));
  const customerId = viewer?.customerId ?? null;
  const token = viewer?.inviteToken ?? null;
  if (!customerId && !token) return base!;
  const who = customerId && token
    ? sql`(di.customer_id = ${customerId} or di.token = ${token})`
    : customerId
      ? sql`di.customer_id = ${customerId}`
      : sql`di.token = ${token}`;
  return or(
    base,
    sql`exists (
      select 1 from drop_products dp
      join drops d on d.id = dp.drop_id
      join drop_invites di on di.drop_id = d.id
      where dp.product_id = ${products.id}
        and d.status in ('scheduled', 'vip_sent')
        and ${who}
        and d.publish_at - make_interval(hours => d.vip_window_hours) <= ${now}
    )`,
  )!;
}

// ---------------------------------------------------------------------------
// 1. listPublicProducts
// ---------------------------------------------------------------------------

const listPublicProductsSchema = z.object({
  categorySlug: z.string().trim().min(1).optional(),
  /** Só peças deste tipo (vestido, corset…): a Lia filtra por ele quando a cliente pede "um corset". */
  pieceType: z.enum(PIECE_TYPE_SLUGS).optional(),
  /** Só estes produtos (página do lançamento). */
  productIds: z.array(z.uuid()).max(50).optional(),
  /** Ignora visible_from (só para quem já provou o convite). */
  includeHidden: z.boolean().default(false),
  viewer: z.object({ customerId: z.uuid().nullable().optional(), inviteToken: z.string().nullable().optional() }).optional(),
  q: z.string().trim().min(1).optional(),
  /** Busca também na descrição (a vendedora do WhatsApp procura por "linho"). */
  includeDescription: z.boolean().default(false),
  /** Deixa um produto de fora (ex.: o próprio, na lista de relacionados). */
  excludeProductId: z.uuid().optional(),
  /** Só as peças de uma Edição de Belém (slug). */
  editionSlug: z.string().trim().min(1).optional(),
  limit: z.number().int().positive().max(200).default(60),
});

export type ListPublicProductsInput = z.input<typeof listPublicProductsSchema>;

export interface PublicProductListItem {
  id: string;
  name: string;
  slug: string;
  brand: string | null;
  categoryName: string | null;
  /** Tipo de peça (slug de core/catalog/piece-types.ts) ou null quando a dona ainda não marcou. */
  pieceType: string | null;
  /** Menor preço ativo entre as variantes vendáveis. */
  priceFromCents: number;
  /** Maior preço ativo entre as variantes vendáveis. */
  priceToCents: number;
  /**
   * Capa da listagem: primeira imagem do produto por sort_order (path no
   * Storage), ou null. Não olha a cor de propósito — a vitrine em lista mostra
   * uma capa só, e a escolha de cor acontece na página do produto.
   */
  imagePath: string | null;
  /** Última alteração da peça (sitemap). */
  updatedAt: Date | null;
  /** Segunda foto por sort_order (troca no hover do card), ou null. */
  hoverImagePath: string | null;
  /** true se a soma de disponível (on_hand - reserved) das variantes > 0. */
  available: boolean;
  /** Descrição, "como veste" ou composição (o primeiro que houver, até 200 chars): a frase da peça para a Lia. Só a listagem principal preenche. */
  blurbSource?: string | null;
  /** Quando a peça entrou no catálogo (novidades no caderninho da Lia). Só a listagem principal preenche. */
  createdAt?: Date;
}

export async function listPublicProducts(
  db: ServiceDb,
  input: ListPublicProductsInput = {},
): Promise<PublicProductListItem[]> {
  const parsed = listPublicProductsSchema.parse(input);

  const filters = [eq(products.status, "active"), isNull(products.deletedAt)];
  if (!parsed.includeHidden) filters.push(publiclyVisible(parsed.viewer));
  if (parsed.productIds) filters.push(inArray(products.id, parsed.productIds));
  if (parsed.categorySlug) filters.push(eq(categories.slug, parsed.categorySlug));
  if (parsed.pieceType) filters.push(eq(products.pieceType, parsed.pieceType));
  if (parsed.excludeProductId) filters.push(ne(products.id, parsed.excludeProductId));
  if (parsed.editionSlug) {
    filters.push(
      sql`exists (
        select 1 from city_edition_products cep join city_editions ce on ce.id = cep.city_edition_id
        where cep.product_id = ${products.id} and ce.slug = ${parsed.editionSlug} and ce.is_active = true
      )`,
    );
  }
  if (parsed.q) {
    const pattern = `%${parsed.q}%`;
    filters.push(
      or(
        ilike(products.name, pattern),
        ilike(products.brand, pattern),
        ...(parsed.includeDescription ? [ilike(products.description, pattern)] : []),
      )!,
    );
  }

  const rows = await db
    .select({
      id: products.id,
      name: products.name,
      slug: products.slug,
      updatedAt: products.updatedAt,
      brand: products.brand,
      categoryName: categories.name,
      pieceType: products.pieceType,
      createdAt: products.createdAt,
      blurbSource: sql<string | null>`left(coalesce(nullif(trim(${products.description}), ''), nullif(trim(${products.fitNotes}), ''), nullif(trim(${products.composition}), '')), 200)`,
      priceFromCents: sql<string>`min(${priceVersions.priceCents})`,
      priceToCents: sql<string>`max(${priceVersions.priceCents})`,
      availableSum: sql<string>`coalesce(sum(greatest(coalesce(${stockLevels.onHand}, 0) - coalesce(${stockLevels.reserved}, 0), 0)), 0)`,
      imagePath: sql<string | null>`(
        select pi.storage_path from product_images pi
        where pi.product_id = ${products.id}
        order by pi.sort_order asc, pi.created_at asc
        limit 1
      )`,
      hoverImagePath: sql<string | null>`(
        select pi.storage_path from product_images pi
        where pi.product_id = ${products.id}
        order by pi.sort_order asc, pi.created_at asc
        offset 1 limit 1
      )`,
    })
    .from(products)
    // INNER joins: produto sem variante ativa com preço ativo fica de fora.
    .innerJoin(productVariants, sellableVariantJoin())
    .innerJoin(priceVersions, activePriceJoin())
    .leftJoin(stockLevels, eq(stockLevels.productVariantId, productVariants.id))
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .where(and(...filters))
    .groupBy(products.id, categories.name)
    .orderBy(
      // Dentro de uma edição, a ordem é a que a dona deu às peças.
      ...(parsed.editionSlug
        ? [
            asc(sql`(
              select cep.sort_order from city_edition_products cep join city_editions ce on ce.id = cep.city_edition_id
              where cep.product_id = ${products.id} and ce.slug = ${parsed.editionSlug} limit 1
            )`),
          ]
        : []),
      desc(products.createdAt),
    )
    .limit(parsed.limit);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    updatedAt: row.updatedAt ?? null,
    brand: row.brand,
    categoryName: row.categoryName,
    pieceType: row.pieceType,
    priceFromCents: Number(row.priceFromCents),
    priceToCents: Number(row.priceToCents),
    imagePath: row.imagePath,
    hoverImagePath: row.hoverImagePath,
    available: Number(row.availableSum) > 0,
    blurbSource: row.blurbSource,
    createdAt: row.createdAt,
  }));
}

// ---------------------------------------------------------------------------
// 1b. listRelatedPublicProducts — "Também na maison" da página do produto.
// Duas chamadas de listPublicProducts (uma única fonte da regra "produto
// público"): a categoria da peça, sem ela mesma; se não sobrar nada (ou a peça
// não tiver categoria), as mais recentes da loja, sem ela mesma.
// ---------------------------------------------------------------------------

const relatedProductsSchema = z.object({
  productId: z.uuid(),
  categorySlug: z.string().trim().min(1).nullable(),
  limit: z.number().int().positive().max(12).default(4),
});

export type RelatedProductsInput = z.input<typeof relatedProductsSchema>;

export interface RelatedProducts {
  /** "category" = peças da mesma sala; "latest" = novidades da loja (fallback). */
  scope: "category" | "latest";
  items: PublicProductListItem[];
}

export async function listRelatedPublicProducts(
  db: ServiceDb,
  input: RelatedProductsInput,
): Promise<RelatedProducts> {
  const parsed = relatedProductsSchema.parse(input);

  if (parsed.categorySlug) {
    const items = await listPublicProducts(db, {
      categorySlug: parsed.categorySlug,
      excludeProductId: parsed.productId,
      limit: parsed.limit,
    });
    if (items.length > 0) return { scope: "category", items };
  }

  const items = await listPublicProducts(db, {
    excludeProductId: parsed.productId,
    limit: parsed.limit,
  });
  return { scope: "latest", items };
}

// ---------------------------------------------------------------------------
// 2. listPublicCategories
// ---------------------------------------------------------------------------

export interface PublicCategory {
  id: string;
  name: string;
  slug: string;
  /** Quantidade de produtos públicos (ativos com preço ativo) na categoria. */
  productCount: number;
  /** Foto de capa da sala (path -full.webp), ou null = capa tipográfica. */
  coverPath: string | null;
  /** Foco vertical da capa em % (0 = topo, 100 = base) para object-position. */
  coverFocalY: number;
}

export async function listPublicCategories(db: ServiceDb): Promise<PublicCategory[]> {
  const rows = await db
    .select({
      id: categories.id,
      name: categories.name,
      slug: categories.slug,
      coverPath: categories.coverPath,
      coverFocalY: categories.coverFocalY,
      productCount: sql<string>`count(distinct ${products.id})`,
    })
    .from(categories)
    .innerJoin(
      products,
      and(
        eq(products.categoryId, categories.id),
        eq(products.status, "active"),
        isNull(products.deletedAt),
        publiclyVisible(),
      ),
    )
    .innerJoin(productVariants, sellableVariantJoin())
    .innerJoin(priceVersions, activePriceJoin())
    .groupBy(categories.id)
    .orderBy(asc(categories.name));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    productCount: Number(row.productCount),
    coverPath: row.coverPath,
    coverFocalY: Number(row.coverFocalY),
  }));
}

// ---------------------------------------------------------------------------
// 3. getPublicProductBySlug
// ---------------------------------------------------------------------------

export interface PublicVariant {
  variantId: string;
  sku: string;
  attributes: Record<string, string>;
  priceCents: number;
  compareAtPriceCents: number | null;
  /** Disponível para venda: max(0, on_hand - reserved). */
  availableQty: number;
  weightGrams: number | null;
  /** Medidas da peça deitada, em cm (fita métrica); null = sem medida. */
  measurements: Measurements | null;
}

export interface PublicProductImage {
  /** Path do arquivo no Storage. */
  path: string;
  /** Cor a que a foto pertence; null = foto do produto inteiro. */
  color: string | null;
}

/** Cartão editorial do post: vira a prévia do link em WhatsApp e Instagram. */
export interface PublicProductDetail {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  /** Ficha da peça (placa de museu): tecido, cuidados e como veste. */
  composition: string | null;
  careNotes: string | null;
  fitNotes: string | null;
  /** Post 4:5 da peça, quando já desenhado: é a prévia do link. */
  postCardPath: string | null;
  /** A nota da curadora: o texto (transcrito ou digitado) e o áudio na voz dela, quando gravado. */
  curatorNote: string | null;
  curatorAudioPath: string | null;
  curatorAudioMime: string | null;
  /** A página /produto/[slug] abre para qualquer pessoa agora (não é só da janela VIP). */
  publicNow: boolean;
  brand: string | null;
  categoryName: string | null;
  /** Slug da categoria (link "Coleção / Sala" e relacionados), ou null. */
  categorySlug: string | null;
  /** Eixos de variação, ex.: ["cor", "tamanho"]. */
  attributesSchema: string[];
  /**
   * Todas as imagens do produto, ordenadas por sort_order. Nada é filtrado
   * aqui: a vitrine recebe a lista inteira e decide o que mostrar por cor.
   */
  images: PublicProductImage[];
  variants: PublicVariant[];
}

export async function getPublicProductBySlug(
  db: ServiceDb,
  slug: string,
  viewer?: CatalogViewer,
  /** includeHidden: ignora visible_from (uso interno — ex.: peça que a dona amarrou a um link de story). */
  opts: { includeHidden?: boolean } = {},
): Promise<PublicProductDetail | null> {
  const parsedSlug = z.string().trim().min(1).parse(slug);

  const [row] = await db
    .select({
      product: products,
      categoryName: categories.name,
      categorySlug: categories.slug,
    })
    .from(products)
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .where(
      and(
        eq(products.slug, parsedSlug),
        eq(products.status, "active"),
        isNull(products.deletedAt),
        ...(opts.includeHidden ? [] : [publiclyVisible(viewer)]),
      ),
    )
    .limit(1);
  if (!row) return null;
  const product = row.product;

  const variantRows = await db
    .select({
      variantId: productVariants.id,
      sku: productVariants.sku,
      attributes: productVariants.attributes,
      weightGrams: productVariants.weightGrams,
      measurements: productVariants.measurements,
      priceCents: priceVersions.priceCents,
      compareAtPriceCents: priceVersions.compareAtPriceCents,
      onHand: sql<string>`coalesce(${stockLevels.onHand}, 0)`,
      reserved: sql<string>`coalesce(${stockLevels.reserved}, 0)`,
    })
    .from(productVariants)
    .innerJoin(priceVersions, activePriceJoin())
    .leftJoin(stockLevels, eq(stockLevels.productVariantId, productVariants.id))
    .where(
      and(
        eq(productVariants.productId, product.id),
        eq(productVariants.isActive, true),
        isNull(productVariants.deletedAt),
      ),
    )
    .orderBy(asc(productVariants.createdAt), asc(productVariants.sku));

  // Sem nenhuma variante vendável, o produto não existe para a vitrine.
  if (variantRows.length === 0) return null;

  const imageRows = await db
    .select({ path: productImages.storagePath, color: productImages.color })
    .from(productImages)
    .where(eq(productImages.productId, product.id))
    .orderBy(asc(productImages.sortOrder), asc(productImages.createdAt));

  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    description: product.description,
    composition: product.composition,
    careNotes: product.careNotes,
    fitNotes: product.fitNotes,
    brand: product.brand,
    postCardPath: product.postCardPath,
    curatorNote: product.curatorNote,
    curatorAudioPath: product.curatorAudioPath,
    curatorAudioMime: product.curatorAudioMime,
    publicNow: product.visibleFrom === null || product.visibleFrom.getTime() <= Date.now(),
    categoryName: row.categoryName,
    categorySlug: row.categorySlug,
    attributesSchema: (product.attributesSchema ?? []) as string[],
    images: imageRows.map((image) => ({ path: image.path, color: image.color })),
    variants: variantRows.map((variant) => ({
      variantId: variant.variantId,
      sku: variant.sku,
      attributes: (variant.attributes ?? {}) as Record<string, string>,
      priceCents: Number(variant.priceCents),
      compareAtPriceCents:
        variant.compareAtPriceCents == null ? null : Number(variant.compareAtPriceCents),
      availableQty: Math.max(0, Number(variant.onHand) - Number(variant.reserved)),
      weightGrams: variant.weightGrams,
      measurements: parseMeasurements(variant.measurements),
    })),
  };
}

// ---------------------------------------------------------------------------
// 4. quoteShipping
// ---------------------------------------------------------------------------

/**
 * Peso padrão (em gramas) usado para itens cuja variante não tem weightGrams
 * cadastrado. Mantém a cotação de frete sempre possível.
 */
export const DEFAULT_ITEM_WEIGHT_GRAMS = 300;

/** Soma o peso do carrinho aplicando DEFAULT_ITEM_WEIGHT_GRAMS aos itens sem peso. */
export function computeTotalWeightGrams(
  items: ReadonlyArray<{ weightGrams: number | null | undefined; quantity: number }>,
): number {
  return items.reduce(
    (sum, item) => sum + (item.weightGrams ?? DEFAULT_ITEM_WEIGHT_GRAMS) * item.quantity,
    0,
  );
}

const quoteShippingSchema = z.object({
  cep: z.string(),
  totalWeightGrams: z
    .number()
    .int({ message: "O peso total deve ser um inteiro em gramas." })
    .min(0, { message: "O peso total não pode ser negativo." }),
});

export type QuoteShippingInput = z.input<typeof quoteShippingSchema>;

export interface ShippingQuote {
  rateId: string;
  name: string;
  priceCents: number;
  deliveryDaysMin: number;
  deliveryDaysMax: number;
  /** 'correios' (prazo em dias) ou 'motoboy' (janelas do dia). Uma linha por faixa, como sempre. */
  kind: ShippingKind;
  deliveryWindows: DeliveryWindow[];
}

/** Normaliza para 8 dígitos; lança ServiceError (pt-BR) se o CEP for inválido. */
export function normalizeCep(cep: string): string {
  const digits = cep.replace(/\D/g, "");
  if (digits.length !== 8) {
    throw new ServiceError("cep_invalido", "CEP inválido. Informe um CEP com 8 dígitos.");
  }
  return digits;
}

/**
 * Cota o frete pelas faixas de shipping_rates: CEP entre cepStart..cepEnd
 * (comparação de STRING de 8 dígitos zero-padded) e peso entre min..max
 * (fronteiras INCLUSIVAS). Array vazio = não entregamos para este CEP.
 */
export async function quoteShipping(
  db: ServiceDb,
  input: QuoteShippingInput,
): Promise<ShippingQuote[]> {
  const parsed = quoteShippingSchema.parse(input);
  const cep = normalizeCep(parsed.cep);

  const rows = await db
    .select({
      rateId: shippingRates.id,
      name: shippingRates.name,
      priceCents: shippingRates.priceCents,
      deliveryDaysMin: shippingRates.deliveryDaysMin,
      deliveryDaysMax: shippingRates.deliveryDaysMax,
      kind: shippingRates.kind,
      deliveryWindows: shippingRates.deliveryWindows,
    })
    .from(shippingRates)
    .where(
      and(
        eq(shippingRates.isActive, true),
        lte(shippingRates.cepStart, cep),
        gte(shippingRates.cepEnd, cep),
        lte(shippingRates.weightMinGrams, parsed.totalWeightGrams),
        gte(shippingRates.weightMaxGrams, parsed.totalWeightGrams),
      ),
    )
    .orderBy(asc(shippingRates.priceCents), asc(shippingRates.sortOrder));

  return rows.map((row) => ({
    rateId: row.rateId,
    name: row.name,
    priceCents: Number(row.priceCents),
    deliveryDaysMin: Number(row.deliveryDaysMin),
    deliveryDaysMax: Number(row.deliveryDaysMax),
    kind: (row.kind === "motoboy" ? "motoboy" : "correios") as ShippingKind,
    deliveryWindows: row.kind === "motoboy" ? parseWindows(row.deliveryWindows) : [],
  }));
}

/** Alguma faixa de motoboy ATIVA cobre o CEP? Só a faixa de CEP — peso e janelas não contam (a exclusividade do motoboy é por CEP). */
export async function activeMotoboyCoversCep(db: ServiceDb, cep: string): Promise<boolean> {
  const [row] = await db
    .select({ id: shippingRates.id })
    .from(shippingRates)
    .where(
      and(
        eq(shippingRates.isActive, true),
        eq(shippingRates.kind, "motoboy"),
        lte(shippingRates.cepStart, cep),
        gte(shippingRates.cepEnd, cep),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** O que a cotação pode usar além das faixas: o provedor dos Correios (ausente = só faixas, como sempre). */
export interface QuoteDeliveryDeps {
  correios?: CorreiosQuoter;
  /** Ensaio da Lia: cota, mas não grava cache (ids descartáveis). */
  dryRun?: boolean;
}

/**
 * As opções que a sacola e o checkout mostram: Correios vira uma; motoboy
 * vira uma por janela ("hoje, 19h–21h · pague até 13h" antes do limite no
 * relógio de SP, "amanhã, 19h–21h" depois). `now` injetável.
 *
 * As faixas da dona mandam. Só quando NENHUMA faixa devolve opção para o
 * CEP — e nenhum motoboy ativo cobre o CEP — entra a cotação automática dos
 * Correios (PAC/SEDEX pela SuperFrete, se ligada em /admin/frete). Falhou
 * ou desligada: lista vazia, o "frete pela equipe" de sempre.
 */
export async function quoteDeliveryOptions(
  db: ServiceDb,
  input: QuoteShippingInput & { now?: Date },
  deps: QuoteDeliveryDeps = {},
): Promise<DeliveryOption[]> {
  const now = input.now ?? new Date();
  const quotes = await quoteShipping(db, { cep: input.cep, totalWeightGrams: input.totalWeightGrams });
  const options = expandDeliveryOptions(quotes, now);
  if (options.length > 0 || !deps.correios) return options;
  const cep = normalizeCep(input.cep);
  if (await activeMotoboyCoversCep(db, cep)) return options;
  const correios = await quoteCorreiosOptions(db, deps.correios, { cep, totalWeightGrams: input.totalWeightGrams, now, dryRun: deps.dryRun });
  return expandDeliveryOptions(correios, now);
}

/**
 * A promessa da página da peça para quem já deu o CEP: "Pague até 17h e
 * chega hoje, 19h–21h" (ou "Chega amanhã, 9h–12h"). Null = sem motoboy para
 * o CEP (os Correios não prometem). CEP inválido também vira null: é um
 * selo, não um erro.
 */
export async function quoteSameDayPromise(
  db: ServiceDb,
  input: { cep: string; totalWeightGrams: number; now?: Date },
): Promise<SameDayPromise | null> {
  const cep = cepDigits(input.cep);
  if (!cep) return null;
  return sameDayPromise(await quoteDeliveryOptions(db, { cep, totalWeightGrams: input.totalWeightGrams, now: input.now }));
}

// ---------------------------------------------------------------------------
// 4b. listPublicVariantFacts — por produto vendável, os tamanhos e as cores
// COM estoque (a cartela de estilo cura a edição por eles).
// ---------------------------------------------------------------------------

export interface PublicVariantFacts {
  product: PublicProductListItem;
  sizesAvailable: string[];
  colorsAvailable: string[];
}

export async function listPublicVariantFacts(
  db: ServiceDb,
  opts: { viewer?: CatalogViewer } = {},
): Promise<PublicVariantFacts[]> {
  return listVariantFactsFor(db, await listPublicProducts(db, { limit: 200, ...(opts.viewer ? { viewer: opts.viewer } : {}) }));
}

/** Cores e tamanhos COM estoque das peças já escolhidas (a Lia só pede para as ≤ 30 linhas que vai mandar). */
export async function listVariantFactsFor(db: ServiceDb, items: readonly PublicProductListItem[]): Promise<PublicVariantFacts[]> {
  if (items.length === 0) return [];
  const rows = await db
    .select({
      productId: productVariants.productId,
      color: sql<string | null>`${productVariants.attributes} ->> 'cor'`,
      size: sql<string | null>`${productVariants.attributes} ->> 'tamanho'`,
      available: sql<string>`coalesce(${stockLevels.onHand}, 0) - coalesce(${stockLevels.reserved}, 0)`,
    })
    .from(productVariants)
    .innerJoin(priceVersions, activePriceJoin())
    .leftJoin(stockLevels, eq(stockLevels.productVariantId, productVariants.id))
    .where(
      and(
        inArray(
          productVariants.productId,
          items.map((item) => item.id),
        ),
        eq(productVariants.isActive, true),
        isNull(productVariants.deletedAt),
      ),
    );
  const sizes = new Map<string, Set<string>>();
  const colors = new Map<string, Set<string>>();
  for (const row of rows) {
    if (Number(row.available) <= 0) continue;
    if (row.size) (sizes.get(row.productId) ?? sizes.set(row.productId, new Set()).get(row.productId))!.add(row.size);
    if (row.color) (colors.get(row.productId) ?? colors.set(row.productId, new Set()).get(row.productId))!.add(row.color);
  }
  return items.map((product) => ({
    product,
    sizesAvailable: [...(sizes.get(product.id) ?? [])].sort(compareSizes),
    colorsAvailable: [...(colors.get(product.id) ?? [])].sort((a, b) => a.localeCompare(b, "pt-BR")),
  }));
}

// ---------------------------------------------------------------------------
// 4b. getSellableVariantBySku — uma variação vendável pelo código (a ponte
// do site, a Lia e a sacola parada falam em SKU). Produto ativo e não
// excluído, variação ativa com preço vigente; null quando não existe.
// ---------------------------------------------------------------------------

export type SellableVariant = {
  variantId: string;
  productId: string;
  sku: string;
  name: string;
  slug: string;
  attributes: Record<string, string>;
  attributesSchema: string[];
  weightGrams: number | null;
  priceCents: number;
  /** Disponível agora (on_hand − reserved), nunca negativo. */
  availableQty: number;
};

/**
 * Pelo SKU (comparação exata sem diferenciar maiúsculas — nunca ILIKE: "%"
 * vindo da internet não é curinga). SKU é adivinhável, então só peça já
 * visível ao público: a ponte anônima não pode revelar lançamento escondido.
 */
export async function getSellableVariantBySku(
  db: ServiceDb,
  sku: string,
  opts: { includeHidden?: boolean } = {},
): Promise<SellableVariant | null> {
  const clean = z.string().trim().min(1).parse(sku);
  return findSellableVariant(db, sql`lower(${productVariants.sku}) = lower(${clean})`, { publicOnly: !opts.includeHidden });
}

/**
 * Pelo id da variação (a sacola do site guarda o id; o SKU é rótulo editável).
 * O id é um UUID não enumerável: quem o tem já viu a peça — inclusive a
 * convidada da janela VIP, cuja sacola precisa chegar inteira à Lia.
 */
export async function getSellableVariantById(db: ServiceDb, variantId: string): Promise<SellableVariant | null> {
  const parsed = z.uuid().safeParse(variantId);
  if (!parsed.success) return null;
  return findSellableVariant(db, eq(productVariants.id, parsed.data), { publicOnly: false });
}

/**
 * Variação vendável AGORA: peça ativa (e, com `publicOnly`, já visível —
 * janela VIP respeitada), variação ativa, com preço ativo; estoque pode ser zero.
 */
async function findSellableVariant(db: ServiceDb, match: SQL, opts: { publicOnly: boolean }): Promise<SellableVariant | null> {
  const [row] = await db
    .select({
      variantId: productVariants.id,
      productId: products.id,
      sku: productVariants.sku,
      name: products.name,
      slug: products.slug,
      attributes: productVariants.attributes,
      attributesSchema: products.attributesSchema,
      weightGrams: productVariants.weightGrams,
      priceCents: priceVersions.priceCents,
      available: sql<string>`coalesce(${stockLevels.onHand}, 0) - coalesce(${stockLevels.reserved}, 0)`,
    })
    .from(productVariants)
    .innerJoin(
      products,
      and(
        eq(products.id, productVariants.productId),
        eq(products.status, "active"),
        isNull(products.deletedAt),
        ...(opts.publicOnly ? [publiclyVisible()] : []),
      ),
    )
    .innerJoin(priceVersions, activePriceJoin())
    .leftJoin(stockLevels, eq(stockLevels.productVariantId, productVariants.id))
    .where(and(match, eq(productVariants.isActive, true), isNull(productVariants.deletedAt)))
    .limit(1);
  if (!row) return null;
  return {
    variantId: row.variantId,
    productId: row.productId,
    sku: row.sku,
    name: row.name,
    slug: row.slug,
    attributes: (row.attributes ?? {}) as Record<string, string>,
    attributesSchema: (row.attributesSchema ?? []) as string[],
    weightGrams: row.weightGrams,
    priceCents: Number(row.priceCents),
    availableQty: Math.max(0, Number(row.available)),
  };
}

// ---------------------------------------------------------------------------
// 5. publicImageUrl — função PURA (roda em server component da vitrine).
// Sem service key: bucket product-images é público no Supabase Storage.
// ---------------------------------------------------------------------------

export function publicImageUrl(path: string): string {
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "");
  if (!base) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL não configurada.");
  }
  return `${base}/storage/v1/object/public/product-images/${path}`;
}

/** Qualquer arquivo público do bucket (o áudio da curadora mora ao lado das fotos). */
export function publicFileUrl(path: string): string {
  return publicImageUrl(path);
}

/** URL do thumbnail derivada por convenção (-full.webp -> -thumb.webp). */
export function publicThumbUrl(path: string): string {
  return publicImageUrl(path.replace("-full.webp", "-thumb.webp"));
}

/**
 * URL da rendição média (800w, -full.webp -> -md.webp), a que o celular usa na
 * galeria. Fotos antigas sem -md são cobertas por scripts/backfill-image-md.ts;
 * o srcset lista thumb/md/full e o navegador escolhe.
 */
export function publicMdUrl(path: string): string {
  return publicImageUrl(path.replace("-full.webp", "-md.webp"));
}

// ---------------------------------------------------------------------------
// 6. Planta da loja e filtro por cor/tamanho — usados pela vendedora do
// WhatsApp para saber o que existe antes de buscar e para curar por atributo.
// ---------------------------------------------------------------------------

export interface StoreMapTypeLine {
  type: string;
  label: string;
  productCount: number;
  priceFromCents: number;
  priceToCents: number;
}

export interface StoreMapCategory {
  /** Tipos de peça dentro da categoria (mais peças primeiro) e quantas ainda estão sem tipo. */
  types: StoreMapTypeLine[];
  untyped: number;
  name: string;
  slug: string;
  productCount: number;
  priceFromCents: number;
  priceToCents: number;
}

export interface StoreMap {
  totalProducts: number;
  categories: StoreMapCategory[];
  /** Valores do eixo "cor" com estoque em alguma peça ativa. */
  colors: string[];
  /** Valores do eixo "tamanho" com estoque em alguma peça ativa. */
  sizes: string[];
  /** Edições de Belém ativas (no ar ou por vir) com peças vendáveis. */
  editions: StoreMapEdition[];
}

/** Resumo estável do catálogo vendável (categorias, faixas, cores e tamanhos). */
export async function getStoreMap(db: ServiceDb): Promise<StoreMap> {
  const categoryRows = await db
    .select({
      id: sql<string | null>`${categories.id}`,
      name: sql<string | null>`${categories.name}`,
      slug: sql<string | null>`${categories.slug}`,
      productCount: sql<string>`count(distinct ${products.id})`,
      priceFromCents: sql<string>`min(${priceVersions.priceCents})`,
      priceToCents: sql<string>`max(${priceVersions.priceCents})`,
    })
    .from(products)
    .innerJoin(productVariants, sellableVariantJoin())
    .innerJoin(priceVersions, activePriceJoin())
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .where(and(eq(products.status, "active"), isNull(products.deletedAt), publiclyVisible()))
    .groupBy(categories.id, categories.name, categories.slug)
    .orderBy(asc(categories.name));

  // Tipos de peça dentro de cada categoria (a planta diz "Vestuário: 12
  // vestidos, 8 blusas, 4 corsets — 2 sem tipo" antes de a Lia buscar).
  const typeRows = await db
    .select({
      categoryId: sql<string | null>`${categories.id}`,
      pieceType: products.pieceType,
      productCount: sql<string>`count(distinct ${products.id})`,
      priceFromCents: sql<string>`min(${priceVersions.priceCents})`,
      priceToCents: sql<string>`max(${priceVersions.priceCents})`,
    })
    .from(products)
    .innerJoin(productVariants, sellableVariantJoin())
    .innerJoin(priceVersions, activePriceJoin())
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .where(and(eq(products.status, "active"), isNull(products.deletedAt), publiclyVisible()))
    .groupBy(categories.id, products.pieceType);
  const typesByCategory = new Map<string, StoreMapTypeLine[]>();
  const untypedByCategory = new Map<string, number>();
  for (const row of typeRows) {
    const key = row.categoryId ?? "";
    if (!row.pieceType) {
      untypedByCategory.set(key, Number(row.productCount));
      continue;
    }
    const known = PIECE_TYPE_SLUGS.includes(row.pieceType as PieceType);
    const list = typesByCategory.get(key) ?? [];
    list.push({
      type: row.pieceType,
      label: known ? pieceTypePlural(row.pieceType as PieceType) : row.pieceType,
      productCount: Number(row.productCount),
      priceFromCents: Number(row.priceFromCents),
      priceToCents: Number(row.priceToCents),
    });
    typesByCategory.set(key, list);
  }

  const axisRows = await db
    .select({
      color: sql<string | null>`${productVariants.attributes} ->> 'cor'`,
      size: sql<string | null>`${productVariants.attributes} ->> 'tamanho'`,
      available: sql<string>`coalesce(sum(greatest(coalesce(${stockLevels.onHand}, 0) - coalesce(${stockLevels.reserved}, 0), 0)), 0)`,
    })
    .from(products)
    .innerJoin(productVariants, sellableVariantJoin())
    .innerJoin(priceVersions, activePriceJoin())
    .leftJoin(stockLevels, eq(stockLevels.productVariantId, productVariants.id))
    .where(and(eq(products.status, "active"), isNull(products.deletedAt), publiclyVisible()))
    .groupBy(sql`1`, sql`2`);

  const colors = new Set<string>();
  const sizes = new Set<string>();
  for (const row of axisRows) {
    if (Number(row.available) <= 0) continue;
    if (row.color) colors.add(row.color);
    if (row.size) sizes.add(row.size);
  }

  const mapped = categoryRows.map((row) => ({
    name: row.name ?? "Sem categoria",
    slug: row.slug ?? "",
    productCount: Number(row.productCount),
    priceFromCents: Number(row.priceFromCents),
    priceToCents: Number(row.priceToCents),
    types: (typesByCategory.get(row.id ?? "") ?? []).sort((a, b) => b.productCount - a.productCount || a.label.localeCompare(b.label, "pt-BR")),
    untyped: untypedByCategory.get(row.id ?? "") ?? 0,
  }));

  // PGlite (testes) e postgres (produção) divergem só no tipo de execute(); a API drizzle é a mesma.
  const editions = await listStoreMapEditions(db as unknown as DbOrTx);

  return {
    totalProducts: mapped.reduce((sum, row) => sum + row.productCount, 0),
    categories: mapped,
    colors: [...colors].sort((a, b) => a.localeCompare(b, "pt-BR")),
    sizes: [...sizes].sort(compareSizes),
    editions,
  };
}

// A ordem de tamanhos mora no core (src/core/catalog/measurements.ts):
// a fita métrica e a Lia usam a mesma.
const compareSizes = compareSizeLabels;

/**
 * Ids dos produtos que têm ao menos uma variante vendável COM ESTOQUE na cor
 * e/ou tamanho pedidos (comparação sem caixa e sem espaços extras). Sem
 * filtro nenhum, devolve null: quem chama não restringe.
 */
export async function listProductIdsWithVariant(
  db: ServiceDb,
  input: { cor?: string; tamanho?: string },
  /** `requireStock: false` = a peça existe nessa cor/tamanho, mesmo esgotada (reconhecer uma foto não depende de estoque). */
  opts: { requireStock?: boolean } = {},
): Promise<Set<string> | null> {
  const cor = input.cor?.trim();
  const tamanho = input.tamanho?.trim();
  if (!cor && !tamanho) return null;

  const filters = [eq(products.status, "active"), isNull(products.deletedAt)];
  if (opts.requireStock !== false) {
    filters.push(sql`coalesce(${stockLevels.onHand}, 0) - coalesce(${stockLevels.reserved}, 0) > 0`);
  }
  if (cor) {
    filters.push(sql`lower(trim(${productVariants.attributes} ->> 'cor')) = lower(${cor})`);
  }
  if (tamanho) {
    filters.push(
      sql`lower(trim(${productVariants.attributes} ->> 'tamanho')) = lower(${tamanho})`,
    );
  }

  const rows = await db
    .selectDistinct({ id: products.id })
    .from(products)
    .innerJoin(productVariants, sellableVariantJoin())
    .innerJoin(priceVersions, activePriceJoin())
    .leftJoin(stockLevels, eq(stockLevels.productVariantId, productVariants.id))
    .where(and(...filters));
  return new Set(rows.map((row) => row.id));
}
