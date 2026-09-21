// Serviço de CUPONS: cotação (quoteCoupon), resgate atômico na mesma
// transação do pedido (redeemCouponInTx), devolução do uso quando o pedido
// cancela sem pagar (releaseCouponRedemptionInTx), emissão automática
// idempotente (issueCoupon) e o CRUD do painel, com auditoria em toda mutação.
//
// A REGRA do que o cupom vale mora em core/coupons/evaluate: aqui só se
// carrega o cupom, as peças e a identidade da cliente, e se traduz a resposta
// do core em ServiceError com frase em português.
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";

import { buildCouponCode, couponCodePrefix, couponCodeSuffix } from "@/core/coupons/codes";
import {
  evaluateCoupon,
  type CouponContextItem,
  type CouponErrorCode,
  type CouponRule,
  type CouponType,
  type FreeShippingScope,
  type PendingCheck,
  type ShippingKind,
} from "@/core/coupons/evaluate";
import { couponErrorMessage } from "@/core/coupons/messages";
import {
  auditLog,
  COUPON_ORIGINS,
  couponCategories,
  couponProducts,
  couponRedemptions,
  coupons,
  customers,
  orders,
  priceVersions,
  productVariants,
  products,
} from "@/db/schema";
import { toE164BR } from "@/lib/phone";
import type { DbOrTx } from "@/queue/enqueue";
import { countCustomerPurchases, findCustomerByDocumentOrPhone } from "@/services/customer-lookup";

export type { CouponType, FreeShippingScope, PendingCheck, ShippingKind };

// ---------------------------------------------------------------------------
// Erros de negócio (mensagens pt-BR prontas para a UI)
// ---------------------------------------------------------------------------

export class ServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
  }
}

/** 23505 vindo direto do driver ou embrulhado pelo Drizzle (cause). */
function isUniqueViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const { code, message, cause } = current as { code?: string; message?: string; cause?: unknown };
    if (code === "23505" || (message ?? "").includes("duplicate key")) return true;
    current = cause;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export type CouponOrigin = (typeof COUPON_ORIGINS)[number];

export interface Coupon extends CouponRule {
  origin: CouponOrigin;
  note: string | null;
  dedupeKey: string | null;
  orderId: string | null;
  referrerCustomerId: string | null;
  updatedAt: Date;
}

const weekdaysSchema = z.array(z.number().int().min(0).max(6)).max(7);

function parseWeekdays(value: unknown): number[] | null {
  const parsed = weekdaysSchema.safeParse(value);
  if (!parsed.success || parsed.data.length === 0) return null;
  return [...new Set(parsed.data)].sort((a, b) => a - b);
}

type CouponRow = typeof coupons.$inferSelect;

function toCoupon(row: CouponRow, productIds: string[], categoryIds: string[]): Coupon {
  return {
    id: row.id,
    code: row.code,
    type: row.type as CouponType,
    value: row.value,
    minOrderCents: row.minOrderCents,
    startsAt: row.startsAt,
    expiresAt: row.expiresAt,
    maxUses: row.maxUses,
    usedCount: row.usedCount,
    isActive: row.isActive,
    perCustomerLimit: row.perCustomerLimit,
    customerId: row.customerId,
    phoneE164: row.phoneE164,
    firstPurchaseOnly: row.firstPurchaseOnly,
    freeShippingScope: row.freeShippingScope as FreeShippingScope,
    validWeekdays: parseWeekdays(row.validWeekdays),
    validFromMinute: row.validFromMinute,
    validToMinute: row.validToMinute,
    productIds,
    categoryIds,
    origin: row.origin as CouponOrigin,
    note: row.note,
    dedupeKey: row.dedupeKey,
    orderId: row.orderId,
    referrerCustomerId: row.referrerCustomerId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** As restrições N:N de vários cupons de uma vez (duas consultas, não 2N). */
async function loadRestrictions(
  db: DbOrTx,
  couponIds: string[],
): Promise<{ productIds: Map<string, string[]>; categoryIds: Map<string, string[]> }> {
  const productIds = new Map<string, string[]>();
  const categoryIds = new Map<string, string[]>();
  if (couponIds.length === 0) return { productIds, categoryIds };
  const productRows = await db
    .select({ couponId: couponProducts.couponId, productId: couponProducts.productId })
    .from(couponProducts)
    .where(inArray(couponProducts.couponId, couponIds));
  for (const row of productRows) {
    productIds.set(row.couponId, [...(productIds.get(row.couponId) ?? []), row.productId]);
  }
  const categoryRows = await db
    .select({ couponId: couponCategories.couponId, categoryId: couponCategories.categoryId })
    .from(couponCategories)
    .where(inArray(couponCategories.couponId, couponIds));
  for (const row of categoryRows) {
    categoryIds.set(row.couponId, [...(categoryIds.get(row.couponId) ?? []), row.categoryId]);
  }
  return { productIds, categoryIds };
}

async function toCoupons(db: DbOrTx, rows: CouponRow[]): Promise<Coupon[]> {
  const restrictions = await loadRestrictions(db, rows.map((row) => row.id));
  return rows.map((row) =>
    toCoupon(row, restrictions.productIds.get(row.id) ?? [], restrictions.categoryIds.get(row.id) ?? []),
  );
}

async function loadCouponByCode(db: DbOrTx, code: string): Promise<Coupon | null> {
  const [row] = await db.select().from(coupons).where(eq(coupons.code, code));
  if (!row) return null;
  const [coupon] = await toCoupons(db, [row]);
  return coupon;
}

async function loadCouponById(db: DbOrTx, couponId: string): Promise<Coupon | null> {
  const [row] = await db.select().from(coupons).where(eq(coupons.id, couponId));
  if (!row) return null;
  const [coupon] = await toCoupons(db, [row]);
  return coupon;
}

function couponError(code: CouponErrorCode, rule: Pick<CouponRule, "code" | "minOrderCents" | "freeShippingScope" | "validWeekdays" | "validFromMinute" | "validToMinute">): ServiceError {
  return new ServiceError(code, couponErrorMessage(code, rule));
}

// ---------------------------------------------------------------------------
// 1. quoteCoupon — valida e calcula o desconto SEM consumir o cupom
// ---------------------------------------------------------------------------

const quoteItemSchema = z.object({
  variantId: z.uuid(),
  quantity: z.number().int().positive().max(999),
});

const quoteCouponSchema = z.object({
  code: z.string().trim().min(1, "Informe o código do cupom."),
  items: z.array(quoteItemSchema).max(100),
  /**
   * Quem está comprando. Ausente/null = sacola anônima (regras por cliente
   * ficam pendentes). Com CPF ou telefone, o cadastro é procurado por aqui.
   */
  identity: z
    .object({
      customerId: z.uuid().nullable().optional(),
      phoneE164: z.string().nullable().optional(),
      documentDigits: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  /** Entrega já escolhida (valor e tipo); null = ainda sem entrega. */
  shipping: z
    .object({ cents: z.number().int().min(0), kind: z.enum(["motoboy", "correios"]) })
    .nullable()
    .optional(),
  now: z.date().optional(),
});

export type QuoteCouponInput = z.input<typeof quoteCouponSchema>;

export interface CouponQuote {
  couponId: string;
  /** Código normalizado (UPPERCASE) — snapshot para orders.coupon_code. */
  code: string;
  type: CouponType;
  discountCents: number;
  /** O valor do cupom usado (10 = "10%", 2000 = R$ 20,00; 0 no frete grátis). */
  appliedValue: number;
  freeShipping: boolean;
  shippingDiscountCents: number;
  /** O que só o fechamento confirma (sacola anônima ou sem entrega escolhida). */
  pending: PendingCheck[];
}

/** Preço ATIVO, produto e categoria de cada linha — nunca o que veio do navegador. */
async function loadCouponItems(
  db: DbOrTx,
  items: { variantId: string; quantity: number }[],
): Promise<CouponContextItem[]> {
  if (items.length === 0) return [];
  const rows = await db
    .select({
      variantId: productVariants.id,
      productId: productVariants.productId,
      categoryId: products.categoryId,
      priceCents: priceVersions.priceCents,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(
      priceVersions,
      and(eq(priceVersions.productVariantId, productVariants.id), eq(priceVersions.status, "active")),
    )
    .where(inArray(productVariants.id, items.map((item) => item.variantId)));
  const byVariant = new Map(rows.map((row) => [row.variantId, row]));
  // Variante sem preço ativo não soma (o checkout a barra com NO_ACTIVE_PRICE).
  return items.flatMap((item) => {
    const row = byVariant.get(item.variantId);
    if (!row) return [];
    return [{ productId: row.productId, categoryId: row.categoryId, unitPriceCents: row.priceCents, quantity: item.quantity }];
  });
}

async function countActiveRedemptions(
  db: DbOrTx,
  couponId: string,
  who: { customerId: string | null; phoneE164: string | null },
): Promise<number> {
  const byWhom =
    who.customerId !== null && who.phoneE164 !== null
      ? or(eq(couponRedemptions.customerId, who.customerId), eq(couponRedemptions.phoneE164, who.phoneE164))
      : who.customerId !== null
        ? eq(couponRedemptions.customerId, who.customerId)
        : who.phoneE164 !== null
          ? eq(couponRedemptions.phoneE164, who.phoneE164)
          : null;
  if (byWhom === null) return 0;
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(couponRedemptions)
    .where(and(eq(couponRedemptions.couponId, couponId), isNull(couponRedemptions.releasedAt), byWhom));
  return row?.count ?? 0;
}

/**
 * Valida o cupom para uma sacola e devolve o desconto calculado. NÃO
 * incrementa used_count — o consumo acontece só em redeemCouponInTx, na
 * mesma transação do pedido.
 */
export async function quoteCoupon(db: DbOrTx, input: QuoteCouponInput): Promise<CouponQuote> {
  const parsed = quoteCouponSchema.parse(input);
  const code = parsed.code.toUpperCase();
  const now = parsed.now ?? new Date();

  const coupon = await loadCouponByCode(db, code);
  if (!coupon) {
    throw new ServiceError("COUPON_NOT_FOUND", couponErrorMessage("COUPON_NOT_FOUND", { code, minOrderCents: 0, freeShippingScope: "any", validWeekdays: null, validFromMinute: null, validToMinute: null }));
  }

  const items = await loadCouponItems(db, parsed.items);

  // Identidade: o cadastro é procurado por CPF/telefone quando o id não veio.
  let identity: { customerId: string | null; phoneE164: string | null } | null = null;
  if (parsed.identity) {
    let customerId = parsed.identity.customerId ?? null;
    let phoneE164 = parsed.identity.phoneE164 ?? null;
    if (customerId === null && (parsed.identity.documentDigits || phoneE164)) {
      const known = await findCustomerByDocumentOrPhone(db, {
        documentDigits: parsed.identity.documentDigits ?? null,
        phoneE164,
      });
      if (known) {
        customerId = known.id;
        phoneE164 = phoneE164 ?? known.phoneE164;
      }
    }
    identity = { customerId, phoneE164 };
  }

  // "Primeira compra" conta também o pedido ainda aguardando pagamento: dois
  // fechamentos seguidos com o mesmo cupom de estreia não passam; se o
  // primeiro expirar, ele é cancelado e deixa de contar.
  const priorPurchases =
    !coupon.firstPurchaseOnly || identity === null
      ? null
      : identity.customerId === null
        ? 0
        : await countCustomerPurchases(db, identity.customerId, { includePending: true });
  const priorRedemptionsByThisCustomer =
    coupon.perCustomerLimit === null || identity === null
      ? null
      : await countActiveRedemptions(db, coupon.id, identity);

  const result = evaluateCoupon(coupon, {
    now,
    items,
    shipping: parsed.shipping ?? null,
    identity,
    priorPurchases,
    priorRedemptionsByThisCustomer,
  });
  if (!result.ok) throw couponError(result.code, coupon);

  return {
    couponId: coupon.id,
    code: coupon.code,
    type: coupon.type,
    discountCents: result.discountCents,
    appliedValue: result.appliedValue,
    freeShipping: result.freeShipping,
    shippingDiscountCents: result.shippingDiscountCents,
    pending: result.pending,
  };
}

// ---------------------------------------------------------------------------
// 2. redeemCouponInTx — consome 1 uso com guard atômico e registra o resgate
// ---------------------------------------------------------------------------

export interface RedeemCouponInput {
  couponId: string;
  orderId: string;
  customerId: string | null;
  phoneE164: string | null;
  code: string;
  discountCents: number;
  shippingDiscountCents: number;
  appliedValue: number;
}

/**
 * Incrementa used_count DENTRO da transação do pedido, com guard atômico no
 * próprio UPDATE (used_count < max_uses OR max_uses IS NULL), grava o resgate
 * e confere o limite por cliente. O UPDATE trava a linha do cupom: dois
 * pedidos simultâneos da mesma cliente contam um de cada vez — o segundo vê o
 * primeiro e a transação dele desfaz o pedido.
 */
export async function redeemCouponInTx(tx: DbOrTx, input: RedeemCouponInput): Promise<void> {
  const [updated] = await tx
    .update(coupons)
    .set({ usedCount: sql`${coupons.usedCount} + 1`, updatedAt: new Date() })
    .where(
      sql`${coupons.id} = ${input.couponId} AND (${coupons.maxUses} IS NULL OR ${coupons.usedCount} < ${coupons.maxUses})`,
    )
    .returning({ id: coupons.id, perCustomerLimit: coupons.perCustomerLimit });

  if (!updated) {
    throw new ServiceError("COUPON_EXHAUSTED", "Este cupom esgotou: o limite de usos já foi atingido.");
  }

  await tx.insert(couponRedemptions).values({
    couponId: input.couponId,
    orderId: input.orderId,
    customerId: input.customerId,
    phoneE164: input.phoneE164,
    code: input.code,
    discountCents: input.discountCents,
    shippingDiscountCents: input.shippingDiscountCents,
    appliedValue: input.appliedValue > 0 ? input.appliedValue : null,
  });

  if (updated.perCustomerLimit !== null) {
    const used = await countActiveRedemptions(tx, input.couponId, {
      customerId: input.customerId,
      phoneE164: input.phoneE164,
    });
    if (used > updated.perCustomerLimit) {
      throw new ServiceError("COUPON_CUSTOMER_LIMIT", "Você já usou este cupom o número de vezes que ele permite.");
    }
  }
}

/**
 * Devolve o uso: o pedido foi cancelado sem nunca ter sido pago. Idempotente
 * (um resgate já devolvido não devolve de novo). Devolve o id do cupom quando
 * havia algo a devolver.
 */
export async function releaseCouponRedemptionInTx(tx: DbOrTx, orderId: string): Promise<string | null> {
  const [released] = await tx
    .update(couponRedemptions)
    .set({ releasedAt: new Date() })
    .where(and(eq(couponRedemptions.orderId, orderId), isNull(couponRedemptions.releasedAt)))
    .returning({ couponId: couponRedemptions.couponId });
  if (!released) return null;
  await tx
    .update(coupons)
    .set({ usedCount: sql`${coupons.usedCount} - 1`, updatedAt: new Date() })
    .where(and(eq(coupons.id, released.couponId), sql`${coupons.usedCount} > 0`));
  return released.couponId;
}

// ---------------------------------------------------------------------------
// 3. issueCoupon — emissão automática, idempotente pela dedupe_key
// ---------------------------------------------------------------------------

const issueCouponSchema = z.object({
  dedupeKey: z.string().trim().min(1).max(200),
  customerId: z.uuid().nullable(),
  // E.164 como no CHECK do banco: recusar aqui evita abortar a transação de quem chama.
  phoneE164: z.string().regex(/^\+[1-9][0-9]{7,14}$/, "Telefone precisa estar em E.164 (+55…).").nullable().optional(),
  origin: z.enum(COUPON_ORIGINS),
  type: z.enum(["percent", "fixed", "free_shipping"]),
  value: z.number().int().min(0),
  expiresAt: z.date(),
  note: z.string().trim().max(500),
  orderId: z.uuid().nullable().optional(),
  referrerCustomerId: z.uuid().nullable().optional(),
  maxUses: z.number().int().positive().nullable().optional(),
  perCustomerLimit: z.number().int().positive().nullable().optional(),
  firstPurchaseOnly: z.boolean().optional(),
  minOrderCents: z.number().int().min(0).optional(),
  productIds: z.array(z.uuid()).optional(),
  freeShippingScope: z.enum(["any", "motoboy", "correios"]).optional(),
  /** Prefixo do código; ausente = primeiro nome da cliente ("AMIGA" sem cliente). */
  codePrefix: z.string().trim().min(1).max(12).optional(),
  now: z.date().optional(),
  random: z.custom<() => number>((value) => typeof value === "function").optional(),
}).superRefine((value, ctx) => {
  // Mesmas réguas do CHECK do banco, com erro legível ANTES do INSERT (um
  // INSERT recusado abortaria a transação de quem chamou).
  if (value.type === "percent" && (value.value < 1 || value.value > 100)) {
    ctx.addIssue({ code: "custom", path: ["value"], message: "Cupom percentual deve estar entre 1 e 100." });
  }
  if (value.type === "fixed" && value.value < 1) {
    ctx.addIssue({ code: "custom", path: ["value"], message: "O valor do cupom deve ser maior que zero." });
  }
  if (value.type === "free_shipping" && value.value !== 0) {
    ctx.addIssue({ code: "custom", path: ["value"], message: "Cupom de frete grátis não tem valor." });
  }
});

export type IssueCouponInput = z.input<typeof issueCouponSchema>;

export interface IssuedCoupon {
  couponId: string;
  code: string;
  expiresAt: Date;
  /** false = a dedupe_key já existia: devolveu o cupom de antes, sem escrever nada. */
  created: boolean;
}

/**
 * Emite um cupom da casa (atraso, proteção de preço, gentileza…). A
 * dedupe_key é o árbitro: chamar de novo com a mesma chave devolve o mesmo
 * cupom. Pessoal por padrão (uso único, 1 por cliente). Chame DENTRO da
 * transação de quem decide emitir.
 */
export async function issueCoupon(tx: DbOrTx, input: IssueCouponInput): Promise<IssuedCoupon> {
  const parsed = issueCouponSchema.parse(input);
  const now = parsed.now ?? new Date();

  const [existing] = await tx
    .select({ id: coupons.id, code: coupons.code, expiresAt: coupons.expiresAt })
    .from(coupons)
    .where(eq(coupons.dedupeKey, parsed.dedupeKey));
  if (existing) {
    return { couponId: existing.id, code: existing.code, expiresAt: existing.expiresAt ?? parsed.expiresAt, created: false };
  }

  let customerName: string | null = null;
  let phoneE164 = parsed.phoneE164 ?? null;
  if (parsed.customerId !== null) {
    const [customer] = await tx
      .select({ fullName: customers.fullName, phoneE164: customers.phoneE164 })
      .from(customers)
      .where(eq(customers.id, parsed.customerId));
    if (!customer) throw new ServiceError("CUSTOMER_NOT_FOUND", "Cliente não encontrada.");
    customerName = customer.fullName;
    phoneE164 = phoneE164 ?? customer.phoneE164;
  }
  const prefix = parsed.codePrefix
    ? couponCodePrefix(parsed.codePrefix)
    : parsed.customerId !== null
      ? couponCodePrefix(customerName)
      : "AMIGA";
  const random = parsed.random ?? Math.random;

  const values = {
    type: parsed.type,
    value: parsed.type === "free_shipping" ? 0 : parsed.value,
    minOrderCents: parsed.minOrderCents ?? 0,
    startsAt: null,
    expiresAt: parsed.expiresAt,
    maxUses: parsed.maxUses === undefined ? 1 : parsed.maxUses,
    usedCount: 0,
    isActive: true,
    origin: parsed.origin,
    note: parsed.note === "" ? null : parsed.note,
    perCustomerLimit: parsed.perCustomerLimit === undefined ? 1 : parsed.perCustomerLimit,
    // Pessoal por cadastro e/ou por telefone (um contato sem cadastro ainda
    // pode ter um cupom só dele); sem nenhum dos dois é um vale aberto.
    customerId: parsed.customerId,
    phoneE164,
    firstPurchaseOnly: parsed.firstPurchaseOnly ?? false,
    freeShippingScope: parsed.freeShippingScope ?? "any",
    dedupeKey: parsed.dedupeKey,
    orderId: parsed.orderId ?? null,
    referrerCustomerId: parsed.referrerCustomerId ?? null,
    createdAt: now,
    updatedAt: now,
  };

  // ON CONFLICT DO NOTHING em vez de try/catch: um INSERT que falha abortaria
  // a transação de quem chamou. Zero linhas = colidiu: ou a dedupe_key (outra
  // rotina gravou antes — devolve o dela) ou o código (raríssimo com 5 letras
  // — sorteia outro).
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = buildCouponCode(prefix, couponCodeSuffix(random));
    const [row] = await tx
      .insert(coupons)
      .values({ ...values, code })
      .onConflictDoNothing()
      .returning({ id: coupons.id });
    if (!row) {
      const [raced] = await tx
        .select({ id: coupons.id, code: coupons.code, expiresAt: coupons.expiresAt })
        .from(coupons)
        .where(eq(coupons.dedupeKey, parsed.dedupeKey));
      if (raced) return { couponId: raced.id, code: raced.code, expiresAt: raced.expiresAt ?? parsed.expiresAt, created: false };
      continue;
    }
    if (parsed.productIds && parsed.productIds.length > 0) {
      await tx.insert(couponProducts).values(parsed.productIds.map((productId) => ({ couponId: row.id, productId })));
    }
    await tx.insert(auditLog).values({
      actorType: "system",
      actorId: null,
      action: "coupon.issue",
      entityType: "coupon",
      entityId: row.id,
      after: {
        code,
        origin: parsed.origin,
        type: values.type,
        value: values.value,
        customerId: parsed.customerId,
        orderId: values.orderId,
        expiresAt: parsed.expiresAt.toISOString(),
        dedupeKey: parsed.dedupeKey,
      },
      reason: values.note,
    });
    return { couponId: row.id, code, expiresAt: parsed.expiresAt, created: true };
  }
  throw new ServiceError("COUPON_CODE_COLLISION", "Não foi possível gerar um código de cupom livre. Tente de novo.");
}

// ---------------------------------------------------------------------------
// 4. Leitura para o painel e para o pedido
// ---------------------------------------------------------------------------

export interface CouponListItem extends Coupon {
  /** Resgates ativos (não devolvidos) — "quem usou". */
  redemptionsCount: number;
  /** Já passou por algum pedido (mesmo devolvido): tipo, valor e regras ficam travados. */
  everRedeemed: boolean;
}

/** Todos os cupons, mais recentes primeiro. */
export async function listCoupons(db: DbOrTx): Promise<CouponListItem[]> {
  const rows = await db.select().from(coupons).orderBy(desc(coupons.createdAt), desc(coupons.id));
  const list = await toCoupons(db, rows);
  const counts = await db
    .select({
      couponId: couponRedemptions.couponId,
      active: sql<number>`count(*) filter (where ${couponRedemptions.releasedAt} is null)::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(couponRedemptions)
    .groupBy(couponRedemptions.couponId);
  const countById = new Map(counts.map((row) => [row.couponId, row]));
  return list.map((coupon) => ({
    ...coupon,
    redemptionsCount: countById.get(coupon.id)?.active ?? 0,
    everRedeemed: (countById.get(coupon.id)?.total ?? 0) > 0,
  }));
}

export async function getCoupon(db: DbOrTx, couponId: string): Promise<Coupon | null> {
  return loadCouponById(db, couponId);
}

/** Cupons que nasceram deste pedido (atraso, proteção de preço, vales da caixa). */
export async function listIssuedCouponsForOrder(db: DbOrTx, orderId: string): Promise<Coupon[]> {
  const rows = await db.select().from(coupons).where(eq(coupons.orderId, orderId)).orderBy(asc(coupons.createdAt));
  return toCoupons(db, rows);
}

/** Cupons pessoais desta cliente, mais recentes primeiro. */
export async function listIssuedCouponsForCustomer(db: DbOrTx, customerId: string): Promise<Coupon[]> {
  const rows = await db
    .select()
    .from(coupons)
    .where(eq(coupons.customerId, customerId))
    .orderBy(desc(coupons.createdAt));
  return toCoupons(db, rows);
}

export interface CouponRedemptionRow {
  id: string;
  orderId: string;
  orderNumber: number;
  orderStatus: string;
  customerId: string | null;
  customerName: string | null;
  discountCents: number;
  shippingDiscountCents: number;
  appliedValue: number | null;
  createdAt: Date;
  releasedAt: Date | null;
}

export interface CouponReport {
  coupon: Coupon;
  redemptions: CouponRedemptionRow[];
}

/** Quem usou o cupom: um resgate por pedido, mais recentes primeiro. */
export async function getCouponReport(db: DbOrTx, couponId: string): Promise<CouponReport | null> {
  const coupon = await loadCouponById(db, couponId);
  if (!coupon) return null;
  const rows = await db
    .select({
      id: couponRedemptions.id,
      orderId: couponRedemptions.orderId,
      orderNumber: orders.orderNumber,
      orderStatus: orders.status,
      customerId: couponRedemptions.customerId,
      customerName: customers.fullName,
      discountCents: couponRedemptions.discountCents,
      shippingDiscountCents: couponRedemptions.shippingDiscountCents,
      appliedValue: couponRedemptions.appliedValue,
      createdAt: couponRedemptions.createdAt,
      releasedAt: couponRedemptions.releasedAt,
    })
    .from(couponRedemptions)
    .innerJoin(orders, eq(orders.id, couponRedemptions.orderId))
    .leftJoin(customers, eq(customers.id, couponRedemptions.customerId))
    .where(eq(couponRedemptions.couponId, couponId))
    .orderBy(desc(couponRedemptions.createdAt));
  return { coupon, redemptions: rows };
}

/**
 * O destino do link /c/CODIGO: cupom ativo e vigente → a peça (quando o cupom
 * é de UMA peça publicada) ou a vitrine. Null = link não vale (nada é guardado).
 */
export async function resolveCouponLink(
  db: DbOrTx,
  code: string,
  now: Date = new Date(),
): Promise<{ code: string; redirectTo: string } | null> {
  const coupon = await loadCouponByCode(db, code.toUpperCase());
  if (!coupon || !coupon.isActive) return null;
  if (coupon.expiresAt !== null && now.getTime() > coupon.expiresAt.getTime()) return null;
  if (coupon.productIds.length === 1) {
    const [product] = await db
      .select({ slug: products.slug })
      .from(products)
      .where(and(eq(products.id, coupon.productIds[0]), eq(products.status, "active"), isNull(products.deletedAt)));
    if (product) return { code: coupon.code, redirectTo: `/produto/${product.slug}` };
  }
  return { code: coupon.code, redirectTo: "/" };
}

// ---------------------------------------------------------------------------
// 5. createCoupon / updateCoupon / deleteCoupon (painel)
// ---------------------------------------------------------------------------

const codeSchema = z
  .string()
  .trim()
  .min(2, "O código do cupom deve ter pelo menos 2 caracteres.")
  .max(40, "O código do cupom deve ter no máximo 40 caracteres.")
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "Use apenas letras, números, hífen e underline no código.")
  .transform((value) => value.toUpperCase());

const ruleFieldsSchema = z.object({
  type: z.enum(["percent", "fixed", "free_shipping"]),
  value: z.number().int().min(0),
  minOrderCents: z.number().int().min(0, "O pedido mínimo não pode ser negativo.").optional(),
  startsAt: z.date().nullable().optional(),
  expiresAt: z.date().nullable().optional(),
  maxUses: z.number().int().positive("O limite de usos deve ser maior que zero.").nullable().optional(),
  perCustomerLimit: z.number().int().positive("O limite por cliente deve ser maior que zero.").nullable().optional(),
  /** Cupom pessoal pelo telefone (E.164): acha o cadastro; sem cadastro, guarda só o telefone. */
  customerPhone: z.string().trim().nullable().optional(),
  firstPurchaseOnly: z.boolean().optional(),
  freeShippingScope: z.enum(["any", "motoboy", "correios"]).optional(),
  validWeekdays: weekdaysSchema.nullable().optional(),
  validFromMinute: z.number().int().min(0).max(1439).nullable().optional(),
  validToMinute: z.number().int().min(1).max(1440).nullable().optional(),
  /** SKU ou slug das peças (o serviço resolve o id). */
  productRefs: z.array(z.string().trim().min(1)).max(200).optional(),
  categoryIds: z.array(z.uuid()).max(100).optional(),
  note: z.string().trim().max(500, "A nota interna deve ter no máximo 500 caracteres.").nullable().optional(),
});

function refineRuleFields(value: z.output<typeof ruleFieldsSchema>, ctx: z.RefinementCtx): void {
  if (value.type === "percent" && (value.value < 1 || value.value > 100)) {
    ctx.addIssue({ code: "custom", path: ["value"], message: "Cupom percentual deve estar entre 1 e 100." });
  }
  if (value.type === "fixed" && value.value < 1) {
    ctx.addIssue({ code: "custom", path: ["value"], message: "O valor do cupom deve ser maior que zero." });
  }
  if (value.type === "free_shipping" && value.value !== 0) {
    ctx.addIssue({ code: "custom", path: ["value"], message: "Cupom de frete grátis não tem valor." });
  }
  if (value.startsAt instanceof Date && value.expiresAt instanceof Date && value.expiresAt.getTime() <= value.startsAt.getTime()) {
    ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "A data de expiração deve ser depois do início da vigência." });
  }
  const from = value.validFromMinute ?? null;
  const to = value.validToMinute ?? null;
  if ((from === null) !== (to === null)) {
    ctx.addIssue({ code: "custom", path: ["validFromMinute"], message: "Informe o horário de início e o de fim." });
  } else if (from !== null && to !== null && from >= to) {
    ctx.addIssue({ code: "custom", path: ["validToMinute"], message: "O fim do horário deve ser depois do início." });
  }
}

const createCouponSchema = ruleFieldsSchema
  .extend({
    code: codeSchema,
    isActive: z.boolean().default(true),
    userId: z.uuid(),
  })
  .superRefine(refineRuleFields);

export type CreateCouponInput = z.input<typeof createCouponSchema>;

/** SKU ou slug → id do produto; referência desconhecida é erro amigável. */
async function resolveProductRefs(db: DbOrTx, refs: string[]): Promise<string[]> {
  if (refs.length === 0) return [];
  const wanted = [...new Set(refs.map((ref) => ref.trim()))];
  const bySlug = await db
    .select({ id: products.id, slug: products.slug })
    .from(products)
    .where(and(inArray(products.slug, wanted.map((ref) => ref.toLowerCase())), isNull(products.deletedAt)));
  const bySku = await db
    .select({ id: productVariants.productId, sku: productVariants.sku })
    .from(productVariants)
    .where(inArray(productVariants.sku, wanted.map((ref) => ref.toUpperCase())));
  const ids = new Set<string>();
  const missing: string[] = [];
  for (const ref of wanted) {
    const slugHit = bySlug.find((row) => row.slug === ref.toLowerCase());
    const skuHit = bySku.find((row) => row.sku === ref.toUpperCase());
    const id = slugHit?.id ?? skuHit?.id;
    if (id) ids.add(id);
    else missing.push(ref);
  }
  if (missing.length > 0) {
    throw new ServiceError("COUPON_PRODUCT_UNKNOWN", `Peça não encontrada: ${missing.join(", ")}. Use o SKU ou o slug como está no catálogo.`);
  }
  return [...ids];
}

/** Telefone como a dona digita → E.164 (+55…); acha o cadastro quando existe. */
async function resolvePersonalIdentity(
  db: DbOrTx,
  customerPhone: string | null | undefined,
): Promise<{ customerId: string | null; phoneE164: string | null }> {
  if (!customerPhone) return { customerId: null, phoneE164: null };
  const phoneE164 = toE164BR(customerPhone);
  if (!phoneE164) {
    throw new ServiceError("COUPON_PHONE_INVALID", "Telefone da cliente inválido: use DDD + número, ex.: (91) 99999-0000.");
  }
  const known = await findCustomerByDocumentOrPhone(db, { phoneE164 });
  return { customerId: known?.id ?? null, phoneE164 };
}

function ruleSnapshot(coupon: Coupon): Record<string, unknown> {
  return {
    code: coupon.code,
    type: coupon.type,
    value: coupon.value,
    minOrderCents: coupon.minOrderCents,
    startsAt: coupon.startsAt?.toISOString() ?? null,
    expiresAt: coupon.expiresAt?.toISOString() ?? null,
    maxUses: coupon.maxUses,
    perCustomerLimit: coupon.perCustomerLimit,
    customerId: coupon.customerId,
    phoneE164: coupon.phoneE164,
    firstPurchaseOnly: coupon.firstPurchaseOnly,
    freeShippingScope: coupon.freeShippingScope,
    validWeekdays: coupon.validWeekdays,
    validFromMinute: coupon.validFromMinute,
    validToMinute: coupon.validToMinute,
    productIds: coupon.productIds,
    categoryIds: coupon.categoryIds,
    isActive: coupon.isActive,
    note: coupon.note,
  };
}

export async function createCoupon(db: DbOrTx, input: CreateCouponInput): Promise<Coupon> {
  const parsed = createCouponSchema.parse(input);

  const duplicateError = new ServiceError(
    "COUPON_CODE_TAKEN",
    `Já existe um cupom com o código "${parsed.code}". Escolha outro código.`,
  );

  return db.transaction(async (tx) => {
    // Pré-checagem amigável; a UNIQUE do banco cobre a corrida (23505 abaixo).
    const [existing] = await tx.select({ id: coupons.id }).from(coupons).where(eq(coupons.code, parsed.code));
    if (existing) throw duplicateError;

    const productIds = await resolveProductRefs(tx, parsed.productRefs ?? []);
    const personal = await resolvePersonalIdentity(tx, parsed.customerPhone);

    let row: CouponRow;
    try {
      [row] = await tx
        .insert(coupons)
        .values({
          code: parsed.code,
          type: parsed.type,
          value: parsed.type === "free_shipping" ? 0 : parsed.value,
          minOrderCents: parsed.minOrderCents ?? 0,
          startsAt: parsed.startsAt ?? null,
          expiresAt: parsed.expiresAt ?? null,
          maxUses: parsed.maxUses ?? null,
          isActive: parsed.isActive,
          perCustomerLimit: parsed.perCustomerLimit ?? null,
          customerId: personal.customerId,
          phoneE164: personal.phoneE164,
          firstPurchaseOnly: parsed.firstPurchaseOnly ?? false,
          freeShippingScope: parsed.freeShippingScope ?? "any",
          validWeekdays: parseWeekdays(parsed.validWeekdays),
          validFromMinute: parsed.validFromMinute ?? null,
          validToMinute: parsed.validToMinute ?? null,
          note: parsed.note || null,
        })
        .returning();
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicateError;
      throw error;
    }
    if (productIds.length > 0) {
      await tx.insert(couponProducts).values(productIds.map((productId) => ({ couponId: row.id, productId })));
    }
    const categoryIds = [...new Set(parsed.categoryIds ?? [])];
    if (categoryIds.length > 0) {
      await tx.insert(couponCategories).values(categoryIds.map((categoryId) => ({ couponId: row.id, categoryId })));
    }

    const coupon = toCoupon(row, productIds, categoryIds);
    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: parsed.userId,
      action: "coupon.create",
      entityType: "coupon",
      entityId: row.id,
      after: ruleSnapshot(coupon),
    });
    return coupon;
  });
}

const updateCouponSchema = ruleFieldsSchema
  .partial()
  .extend({
    couponId: z.uuid(),
    isActive: z.boolean().optional(),
    userId: z.uuid(),
  });

export type UpdateCouponInput = z.input<typeof updateCouponSchema>;

/** Campos que só mudam enquanto ninguém usou o cupom (integridade histórica dos pedidos). */
const LOCKED_AFTER_USE = [
  "type",
  "value",
  "minOrderCents",
  "startsAt",
  "perCustomerLimit",
  "customerPhone",
  "firstPurchaseOnly",
  "freeShippingScope",
  "validWeekdays",
  "validFromMinute",
  "validToMinute",
  "productRefs",
  "categoryIds",
] as const;

/**
 * Ajustes do cupom. Ativar/desativar, expiração, limite de usos e nota podem
 * mudar sempre; o resto (tipo, valor, regras, peças) só enquanto o cupom
 * nunca foi usado — pedidos já criados referenciam o cupom, e o que ele
 * valia tem de continuar sendo verdade.
 */
export async function updateCoupon(db: DbOrTx, input: UpdateCouponInput): Promise<Coupon> {
  const parsed = updateCouponSchema.parse(input);

  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(coupons).where(eq(coupons.id, parsed.couponId)).for("update");
    if (!current) throw new ServiceError("COUPON_NOT_FOUND", "Cupom não encontrado.");
    const before = (await toCoupons(tx, [current]))[0];

    const touchesLocked = LOCKED_AFTER_USE.some((field) => parsed[field] !== undefined);
    if (touchesLocked) {
      const [anyRedemption] = await tx
        .select({ id: couponRedemptions.id })
        .from(couponRedemptions)
        .where(eq(couponRedemptions.couponId, parsed.couponId))
        .limit(1);
      if (current.usedCount > 0 || anyRedemption) {
        throw new ServiceError("COUPON_IN_USE", "Este cupom já foi usado; para outro desconto ou outras regras, crie um cupom novo.");
      }
    }

    // As regras juntas (o que veio + o que já era) passam pela mesma validação do create.
    const rule = ruleFieldsSchema.superRefine(refineRuleFields).parse({
      type: parsed.type ?? before.type,
      value: parsed.value ?? before.value,
      minOrderCents: parsed.minOrderCents ?? before.minOrderCents,
      startsAt: parsed.startsAt === undefined ? before.startsAt : parsed.startsAt,
      expiresAt: parsed.expiresAt === undefined ? before.expiresAt : parsed.expiresAt,
      maxUses: parsed.maxUses === undefined ? before.maxUses : parsed.maxUses,
      perCustomerLimit: parsed.perCustomerLimit === undefined ? before.perCustomerLimit : parsed.perCustomerLimit,
      customerPhone: parsed.customerPhone === undefined ? before.phoneE164 : parsed.customerPhone,
      firstPurchaseOnly: parsed.firstPurchaseOnly ?? before.firstPurchaseOnly,
      freeShippingScope: parsed.freeShippingScope ?? before.freeShippingScope,
      validWeekdays: parsed.validWeekdays === undefined ? before.validWeekdays : parsed.validWeekdays,
      validFromMinute: parsed.validFromMinute === undefined ? before.validFromMinute : parsed.validFromMinute,
      validToMinute: parsed.validToMinute === undefined ? before.validToMinute : parsed.validToMinute,
      note: parsed.note === undefined ? before.note : parsed.note,
    });

    const set: Partial<typeof coupons.$inferInsert> = { updatedAt: new Date() };
    if (parsed.isActive !== undefined) set.isActive = parsed.isActive;
    if (parsed.expiresAt !== undefined) set.expiresAt = parsed.expiresAt;
    if (parsed.maxUses !== undefined) set.maxUses = parsed.maxUses;
    if (parsed.note !== undefined) set.note = parsed.note || null;
    if (touchesLocked) {
      set.type = rule.type;
      set.value = rule.type === "free_shipping" ? 0 : rule.value;
      set.minOrderCents = rule.minOrderCents ?? 0;
      set.startsAt = rule.startsAt ?? null;
      set.perCustomerLimit = rule.perCustomerLimit ?? null;
      set.firstPurchaseOnly = rule.firstPurchaseOnly ?? false;
      set.freeShippingScope = rule.freeShippingScope ?? "any";
      set.validWeekdays = parseWeekdays(rule.validWeekdays);
      set.validFromMinute = rule.validFromMinute ?? null;
      set.validToMinute = rule.validToMinute ?? null;
      // Vínculo pessoal: só muda quando o telefone muda de verdade. Telefone
      // igual ao de antes não re-resolve (não perde o cadastro); vazio só
      // solta o vínculo quando ele era por telefone — um cupom preso ao
      // cadastro (emitido pela casa) não vira aberto porque o form veio vazio.
      if (parsed.customerPhone !== undefined) {
        const nextPhone = parsed.customerPhone ? toE164BR(parsed.customerPhone) : null;
        if (parsed.customerPhone && !nextPhone) {
          throw new ServiceError("COUPON_PHONE_INVALID", "Telefone da cliente inválido: use DDD + número, ex.: (91) 99999-0000.");
        }
        if (nextPhone !== before.phoneE164 && (nextPhone !== null || before.phoneE164 !== null)) {
          const personal = await resolvePersonalIdentity(tx, nextPhone);
          set.customerId = personal.customerId;
          set.phoneE164 = personal.phoneE164;
        }
      }
    }

    const [row] = await tx.update(coupons).set(set).where(eq(coupons.id, parsed.couponId)).returning();

    let productIds = before.productIds;
    if (parsed.productRefs !== undefined) {
      productIds = await resolveProductRefs(tx, parsed.productRefs);
      await tx.delete(couponProducts).where(eq(couponProducts.couponId, row.id));
      if (productIds.length > 0) {
        await tx.insert(couponProducts).values(productIds.map((productId) => ({ couponId: row.id, productId })));
      }
    }
    let categoryIds = before.categoryIds;
    if (parsed.categoryIds !== undefined) {
      categoryIds = [...new Set(parsed.categoryIds)];
      await tx.delete(couponCategories).where(eq(couponCategories.couponId, row.id));
      if (categoryIds.length > 0) {
        await tx.insert(couponCategories).values(categoryIds.map((categoryId) => ({ couponId: row.id, categoryId })));
      }
    }

    const after = toCoupon(row, productIds, categoryIds);
    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: parsed.userId,
      action: "coupon.update",
      entityType: "coupon",
      entityId: row.id,
      before: ruleSnapshot(before),
      after: ruleSnapshot(after),
    });
    return after;
  });
}

/** Apaga um cupom que ninguém usou (com resgate, mesmo devolvido, fica no histórico: desative). */
export async function deleteCoupon(db: DbOrTx, input: { couponId: string; userId: string }): Promise<void> {
  const parsed = z.object({ couponId: z.uuid(), userId: z.uuid() }).parse(input);
  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(coupons).where(eq(coupons.id, parsed.couponId)).for("update");
    if (!current) throw new ServiceError("COUPON_NOT_FOUND", "Cupom não encontrado.");
    const [anyRedemption] = await tx
      .select({ id: couponRedemptions.id })
      .from(couponRedemptions)
      .where(eq(couponRedemptions.couponId, parsed.couponId))
      .limit(1);
    if (current.usedCount > 0 || anyRedemption) {
      throw new ServiceError("COUPON_IN_USE", "Este cupom já foi usado e fica no histórico: desative em vez de excluir.");
    }
    const before = (await toCoupons(tx, [current]))[0];
    await tx.delete(coupons).where(eq(coupons.id, parsed.couponId));
    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: parsed.userId,
      action: "coupon.delete",
      entityType: "coupon",
      entityId: parsed.couponId,
      before: ruleSnapshot(before),
    });
  });
}
