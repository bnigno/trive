// Motoboys: o cadastro simples (nome + WhatsApp) de quem faz a saída. O
// telefone vale em dois lugares: recebe o link da saída e, quando ele
// responde ao número da loja, a mensagem vai para a dona — nunca para a Lia.
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { auditLog, couriers } from "@/db/schema";
import { toE164BR } from "@/lib/phone";
import type { DbOrTx } from "@/queue/enqueue";
import { ServiceError } from "@/services/orders";

export interface Courier {
  id: string;
  name: string;
  phoneE164: string;
  isActive: boolean;
  createdAt: Date;
}

const nameSchema = z.string().trim().min(1, "Informe o nome do motoboy.").max(60, "Nome com até 60 caracteres.");
const phoneSchema = z
  .string()
  .trim()
  .min(1, "Informe o WhatsApp do motoboy.")
  .transform((raw, ctx) => {
    const e164 = toE164BR(raw);
    if (!e164) {
      ctx.addIssue({ code: "custom", message: "WhatsApp inválido — use DDD + número." });
      return z.NEVER;
    }
    return e164;
  });

const createCourierSchema = z.object({ name: nameSchema, phone: phoneSchema, userId: z.uuid() });
const updateCourierSchema = z.object({
  courierId: z.uuid(),
  name: nameSchema.optional(),
  phone: phoneSchema.optional(),
  isActive: z.boolean().optional(),
  userId: z.uuid(),
});

export type CreateCourierInput = z.input<typeof createCourierSchema>;
export type UpdateCourierInput = z.input<typeof updateCourierSchema>;

function toCourier(row: typeof couriers.$inferSelect): Courier {
  return { id: row.id, name: row.name, phoneE164: row.phoneE164, isActive: row.isActive, createdAt: row.createdAt };
}

export async function listCouriers(db: DbOrTx, input: { includeInactive?: boolean } = {}): Promise<Courier[]> {
  const rows = await db
    .select()
    .from(couriers)
    .where(input.includeInactive ? undefined : eq(couriers.isActive, true))
    .orderBy(asc(couriers.name));
  return rows.map(toCourier);
}

export async function createCourier(db: DbOrTx, input: CreateCourierInput): Promise<Courier> {
  const parsed = createCourierSchema.parse(input);
  return db.transaction(async (tx) => {
    const [existing] = await tx.select({ id: couriers.id }).from(couriers).where(eq(couriers.phoneE164, parsed.phone)).limit(1);
    if (existing) throw new ServiceError("COURIER_PHONE_TAKEN", "Já existe um motoboy com este WhatsApp.");
    // Duas abas cadastrando o mesmo número ao mesmo tempo: o UNIQUE decide.
    const [row] = await tx.insert(couriers).values({ name: parsed.name, phoneE164: parsed.phone }).onConflictDoNothing().returning();
    if (!row) throw new ServiceError("COURIER_PHONE_TAKEN", "Já existe um motoboy com este WhatsApp.");
    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: parsed.userId,
      action: "courier.create",
      entityType: "courier",
      entityId: row.id,
      after: { name: row.name, phoneE164: row.phoneE164 },
    });
    return toCourier(row);
  });
}

export async function updateCourier(db: DbOrTx, input: UpdateCourierInput): Promise<Courier> {
  const parsed = updateCourierSchema.parse(input);
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(couriers).where(eq(couriers.id, parsed.courierId)).for("update");
    if (!current) throw new ServiceError("COURIER_NOT_FOUND", "Motoboy não encontrado.");
    if (parsed.phone && parsed.phone !== current.phoneE164) {
      const [taken] = await tx.select({ id: couriers.id }).from(couriers).where(eq(couriers.phoneE164, parsed.phone)).limit(1);
      if (taken) throw new ServiceError("COURIER_PHONE_TAKEN", "Já existe um motoboy com este WhatsApp.");
    }
    const [row] = await tx
      .update(couriers)
      .set({
        name: parsed.name ?? current.name,
        phoneE164: parsed.phone ?? current.phoneE164,
        isActive: parsed.isActive ?? current.isActive,
        updatedAt: new Date(),
      })
      .where(eq(couriers.id, current.id))
      .returning();
    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: parsed.userId,
      action: "courier.update",
      entityType: "courier",
      entityId: row.id,
      before: { name: current.name, phoneE164: current.phoneE164, isActive: current.isActive },
      after: { name: row.name, phoneE164: row.phoneE164, isActive: row.isActive },
    });
    return toCourier(row);
  });
}

/** Motoboy ativo com este número: a mensagem dele é para a dona, não para a Lia. */
export async function findActiveCourierByPhone(db: DbOrTx, phoneE164: string): Promise<Courier | null> {
  const [row] = await db
    .select()
    .from(couriers)
    .where(and(eq(couriers.phoneE164, phoneE164), eq(couriers.isActive, true)))
    .limit(1);
  return row ? toCourier(row) : null;
}
