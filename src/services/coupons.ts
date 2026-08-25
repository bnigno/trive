// Serviço de CUPONS de desconto (Fase 5): cotação no checkout (quoteCoupon),
// resgate atômico na mesma transação do pedido (redeemCouponInTx) e CRUD do
// admin (listCoupons/createCoupon/updateCoupon), com auditoria em toda mutação.
//
// Regras de valor:
//   - percent: desconto = floor(subtotal * value / 100), value entre 1 e 100.
//   - fixed:   desconto em centavos, NUNCA maior que o subtotal (clamp).
// Assim o desconto cotado sempre passa em computeOrderTotals (discount <= subtotal).
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { auditLog, coupons } from "@/db/schema";
import { formatCentsBRL } from "@/lib/money";
import type { DbOrTx } from "@/queue/enqueue";

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

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export type CouponType = "percent" | "fixed";

export interface Coupon {
  id: string;
  code: string;
  type: CouponType;
  value: number;
  minOrderCents: number;
  startsAt: Date | null;
  expiresAt: Date | null;
  maxUses: number | null;
  usedCount: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function toCoupon(row: typeof coupons.$inferSelect): Coupon {
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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// 1. quoteCoupon — valida e calcula o desconto SEM consumir o cupom
// ---------------------------------------------------------------------------

const quoteCouponSchema = z.object({
  code: z.string().trim().min(1, "Informe o código do cupom."),
  subtotalCents: z.number().int().min(0),
});

export type QuoteCouponInput = z.input<typeof quoteCouponSchema>;

export interface CouponQuote {
  couponId: string;
  /** Código normalizado (UPPERCASE) — snapshot para orders.coupon_code. */
  code: string;
  discountCents: number;
}

/**
 * Valida o cupom para um subtotal e devolve o desconto calculado. NÃO
 * incrementa used_count — o consumo acontece só em redeemCouponInTx, na
 * mesma transação do pedido.
 *
 * Vigência: comparada com o relógio da APLICAÇÃO (new Date()), não com o
 * now() do banco. Uma margem de poucos segundos de deriva de relógio é
 * aceitável para cupons e evita uma ida extra ao banco.
 */
export async function quoteCoupon(
  db: DbOrTx,
  input: QuoteCouponInput,
): Promise<CouponQuote> {
  const parsed = quoteCouponSchema.parse(input);
  const code = parsed.code.toUpperCase();

  const [coupon] = await db.select().from(coupons).where(eq(coupons.code, code));
  if (!coupon) {
    throw new ServiceError(
      "COUPON_NOT_FOUND",
      `Cupom "${code}" não existe. Confira o código e tente de novo.`,
    );
  }
  if (!coupon.isActive) {
    throw new ServiceError(
      "COUPON_INACTIVE",
      "Este cupom não está mais ativo.",
    );
  }

  const now = new Date();
  if (coupon.startsAt !== null && now.getTime() < coupon.startsAt.getTime()) {
    throw new ServiceError(
      "COUPON_NOT_STARTED",
      "Este cupom ainda não está em vigência. Tente novamente mais tarde.",
    );
  }
  if (coupon.expiresAt !== null && now.getTime() > coupon.expiresAt.getTime()) {
    throw new ServiceError("COUPON_EXPIRED", "Este cupom expirou.");
  }
  if (coupon.maxUses !== null && coupon.usedCount >= coupon.maxUses) {
    throw new ServiceError(
      "COUPON_EXHAUSTED",
      "Este cupom esgotou: o limite de usos já foi atingido.",
    );
  }
  if (parsed.subtotalCents < coupon.minOrderCents) {
    throw new ServiceError(
      "COUPON_MIN_ORDER",
      `Este cupom vale para pedidos a partir de ${formatCentsBRL(coupon.minOrderCents)}.`,
    );
  }

  const discountCents =
    coupon.type === "percent"
      ? Math.floor((parsed.subtotalCents * coupon.value) / 100)
      : Math.min(coupon.value, parsed.subtotalCents);

  return { couponId: coupon.id, code: coupon.code, discountCents };
}

// ---------------------------------------------------------------------------
// 2. redeemCouponInTx — consome 1 uso com guard atômico
// ---------------------------------------------------------------------------

/**
 * Incrementa used_count DENTRO da transação do pedido, com guard atômico no
 * próprio UPDATE (used_count < max_uses OR max_uses IS NULL). Dois pedidos
 * simultâneos disputando o último uso: um incrementa, o outro afeta 0 linhas
 * e recebe o erro de esgotado — a transação do perdedor desfaz o pedido.
 */
export async function redeemCouponInTx(
  tx: DbOrTx,
  couponId: string,
): Promise<void> {
  const updated = await tx
    .update(coupons)
    .set({
      usedCount: sql`${coupons.usedCount} + 1`,
      updatedAt: new Date(),
    })
    .where(
      sql`${coupons.id} = ${couponId} AND (${coupons.maxUses} IS NULL OR ${coupons.usedCount} < ${coupons.maxUses})`,
    )
    .returning({ id: coupons.id });

  if (updated.length === 0) {
    throw new ServiceError(
      "COUPON_EXHAUSTED",
      "Este cupom esgotou: o limite de usos já foi atingido.",
    );
  }
}

// ---------------------------------------------------------------------------
// 3. listCoupons
// ---------------------------------------------------------------------------

/** Todos os cupons (com contagem de usos), mais recentes primeiro. */
export async function listCoupons(db: DbOrTx): Promise<Coupon[]> {
  const rows = await db
    .select()
    .from(coupons)
    .orderBy(desc(coupons.createdAt), desc(coupons.id));
  return rows.map(toCoupon);
}

// ---------------------------------------------------------------------------
// 4. createCoupon
// ---------------------------------------------------------------------------

const createCouponSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(2, "O código do cupom deve ter pelo menos 2 caracteres.")
      .max(40, "O código do cupom deve ter no máximo 40 caracteres.")
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
        "Use apenas letras, números, hífen e underline no código.",
      )
      .transform((value) => value.toUpperCase()),
    type: z.enum(["percent", "fixed"]),
    value: z.number().int().positive("O valor do cupom deve ser maior que zero."),
    minOrderCents: z
      .number()
      .int()
      .min(0, "O pedido mínimo não pode ser negativo.")
      .default(0),
    startsAt: z.date().nullable().optional(),
    expiresAt: z.date().nullable().optional(),
    maxUses: z
      .number()
      .int()
      .positive("O limite de usos deve ser maior que zero.")
      .nullable()
      .optional(),
    isActive: z.boolean().default(true),
    userId: z.uuid(),
  })
  .superRefine((value, ctx) => {
    if (value.type === "percent" && value.value > 100) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: "Cupom percentual deve estar entre 1 e 100.",
      });
    }
    if (
      value.startsAt instanceof Date &&
      value.expiresAt instanceof Date &&
      value.expiresAt.getTime() <= value.startsAt.getTime()
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "A data de expiração deve ser depois do início da vigência.",
      });
    }
  });

export type CreateCouponInput = z.input<typeof createCouponSchema>;

export async function createCoupon(
  db: DbOrTx,
  input: CreateCouponInput,
): Promise<Coupon> {
  const parsed = createCouponSchema.parse(input);

  const duplicateError = new ServiceError(
    "COUPON_CODE_TAKEN",
    `Já existe um cupom com o código "${parsed.code}". Escolha outro código.`,
  );

  return db.transaction(async (tx) => {
    // Pré-checagem amigável; a UNIQUE do banco cobre a corrida (23505 abaixo).
    const [existing] = await tx
      .select({ id: coupons.id })
      .from(coupons)
      .where(eq(coupons.code, parsed.code));
    if (existing) throw duplicateError;

    let row: typeof coupons.$inferSelect;
    try {
      [row] = await tx
        .insert(coupons)
        .values({
          code: parsed.code,
          type: parsed.type,
          value: parsed.value,
          minOrderCents: parsed.minOrderCents,
          startsAt: parsed.startsAt ?? null,
          expiresAt: parsed.expiresAt ?? null,
          maxUses: parsed.maxUses ?? null,
          isActive: parsed.isActive,
        })
        .returning();
    } catch (error) {
      const pgCode = (error as { code?: string }).code;
      const message = error instanceof Error ? error.message : "";
      if (pgCode === "23505" || message.includes("duplicate key")) {
        throw duplicateError;
      }
      throw error;
    }

    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: parsed.userId,
      action: "coupon.create",
      entityType: "coupon",
      entityId: row.id,
      after: {
        code: row.code,
        type: row.type,
        value: row.value,
        minOrderCents: row.minOrderCents,
        startsAt: row.startsAt?.toISOString() ?? null,
        expiresAt: row.expiresAt?.toISOString() ?? null,
        maxUses: row.maxUses,
        isActive: row.isActive,
      },
    });

    return toCoupon(row);
  });
}

// ---------------------------------------------------------------------------
// 5. updateCoupon
// ---------------------------------------------------------------------------

const updateCouponSchema = z.object({
  couponId: z.uuid(),
  isActive: z.boolean().optional(),
  expiresAt: z.date().nullable().optional(),
  maxUses: z
    .number()
    .int()
    .positive("O limite de usos deve ser maior que zero.")
    .nullable()
    .optional(),
  userId: z.uuid(),
});

export type UpdateCouponInput = z.input<typeof updateCouponSchema>;

/**
 * Ajustes operacionais do cupom: ativar/desativar, mudar expiração e limite
 * de usos. `type` e `value` NÃO são editáveis por aqui de propósito: pedidos
 * já criados referenciam o cupom (integridade histórica) — para mudar o
 * desconto, crie um cupom novo e desative o antigo.
 */
export async function updateCoupon(
  db: DbOrTx,
  input: UpdateCouponInput,
): Promise<Coupon> {
  const parsed = updateCouponSchema.parse(input);

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(coupons)
      .where(eq(coupons.id, parsed.couponId))
      .for("update");
    if (!current) {
      throw new ServiceError("COUPON_NOT_FOUND", "Cupom não encontrado.");
    }

    const set: Partial<typeof coupons.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (parsed.isActive !== undefined) set.isActive = parsed.isActive;
    if (parsed.expiresAt !== undefined) set.expiresAt = parsed.expiresAt;
    if (parsed.maxUses !== undefined) set.maxUses = parsed.maxUses;

    const [row] = await tx
      .update(coupons)
      .set(set)
      .where(eq(coupons.id, parsed.couponId))
      .returning();

    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: parsed.userId,
      action: "coupon.update",
      entityType: "coupon",
      entityId: row.id,
      before: {
        isActive: current.isActive,
        expiresAt: current.expiresAt?.toISOString() ?? null,
        maxUses: current.maxUses,
      },
      after: {
        isActive: row.isActive,
        expiresAt: row.expiresAt?.toISOString() ?? null,
        maxUses: row.maxUses,
      },
    });

    return toCoupon(row);
  });
}
